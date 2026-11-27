import {
  type EnvironmentId,
  HOME_LAUNCHED_THREAD_ID_PREFIX,
  MessageId,
  type ModelSelection,
  ThreadId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type TaskFolderError,
  type ServerProvider,
  T3_PROJECT_FILE_NAME,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { OrchestratorRuntimeModeAboveCeilingError } from "../../../orchestration-v2/Orchestrator.ts";
import { outputRequestProblem } from "../../../orchestration-v2/runOutput.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import { refuseHomeFolder } from "../../../home/FleetService.ts";
import * as HomeService from "../../../home/HomeService.ts";
import * as HomeWorkspace from "../../../home/HomeWorkspace.ts";
import { callerIsHome, routeHome, runAsHome } from "../../homeRouting.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import { mutateProjectWithClone } from "../../../project/ProjectMutation.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as DateTime from "effect/DateTime";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import {
  resolveProjectFileBackedSetting,
  resolveProjectSettings,
} from "@t3tools/shared/projectSettings";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import {
  providerOptionDescriptors,
  refuseAgentModePick,
  resolveRuntimeMode,
} from "../../delegatedTaskModes.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestrationMcp from "../../OrchestratorMcpService.ts";
import {
  launchCommandId,
  newCommandId,
  readCaller,
  resolveProjectId,
  unavailable,
} from "../../threadAccess.ts";
import {
  cloneProject,
  createProject,
  withSavedProjectSettings,
  projectFailure,
  updateProject,
} from "../../projectOperations.ts";
import { ProjectToolkit } from "./tools.ts";

const isAboveCeilingError = Schema.is(OrchestratorRuntimeModeAboveCeilingError);

function worktreeCheckHint(
  error:
    | ThreadLaunch.ThreadLaunchBaseRefError
    | ThreadLaunch.ThreadLaunchBranchExistsError
    | ThreadLaunch.ThreadLaunchBranchConflictError
    | ThreadLaunch.ThreadLaunchNotRepositoryError
    | TaskFolderError,
  strategy: { readonly startFromOrigin?: boolean | undefined },
) {
  if (error._tag === "TaskFolderError")
    return "Pass `repositories` paths from the project's tracked Git folders.";
  if (error._tag === "ThreadLaunchNotRepositoryError")
    return `Use workspaceStrategy: {type: "root"}, or pass the projectId of a Git repository.`;
  if (error._tag === "ThreadLaunchBranchExistsError")
    return "Pass a branch name that does not exist yet, or omit branch to get a generated name.";
  if (error._tag === "ThreadLaunchBranchConflictError") {
    const sibling = error.branch.replaceAll("/", "-");
    return `Use a name that does not nest under or contain an existing branch${
      sibling === error.branch ? "" : `, such as "${sibling}"`
    }.`;
  }
  return `Pass a branch, tag, or commit that exists there${
    strategy.startFromOrigin === true
      ? "; no remote of the project has it either."
      : ", or set startFromOrigin:true if it exists only on a remote."
  }`;
}

/**
 * Require project worktrees so launches cannot target arbitrary host directories. Returns the
 * path Git registered, so the thread stays bound to that worktree.
 */
const projectWorktreePath = Effect.fn("mcp.assertProjectWorktree")(function* (
  workspaceRoot: string,
  worktreePath: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const real = (path: string) => fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));
  const registered = yield* git
    .listWorktreePaths(workspaceRoot)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const requested = yield* real(worktreePath);
  for (const candidate of registered) {
    if ((yield* real(candidate)) === requested) return candidate;
  }
  return yield* new OrchestratorMcpFailure({
    code: "invalid_request",
    message:
      "worktreePath must be one of the project's git worktrees. t3_worktree_list shows them.",
  });
});

/** The composer falls back to the project's t3.json when no setting picks the mode. */
const projectFileThreadEnvMode = Effect.fn("mcp.projectFileThreadEnvMode")(function* (
  workspaceRoot: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem
    .readFileString(`${workspaceRoot}/${T3_PROJECT_FILE_NAME}`)
    .pipe(Effect.orElseSucceed(() => null));
  return resolveProjectFileBackedSetting(
    "defaultThreadEnvMode",
    null,
    contents === null ? null : parseT3ProjectFile(contents),
  ).value;
});

// Anchored to the fatal line: other diagnostics, such as a dubious-ownership refusal, quote the path.
const NON_REPOSITORY_FATAL =
  /^fatal: (?:not a git repository|gitfile does not point to a valid repository)/im;

/** Branches from the checkout's current branch, as the composer does; a checkout with no commit or a detached HEAD stays shared. */
const defaultWorktreeStrategy = Effect.fn("mcp.defaultWorktreeStrategy")(function* (
  workspaceRoot: string,
): Effect.fn.Return<
  OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined,
  OrchestratorMcpFailure,
  GitVcsDriver.GitVcsDriver
> {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const unreadable = new OrchestratorMcpFailure({
    code: "orchestration_error",
    message:
      "Could not read the project's current branch for the new worktree. No thread was created. Retry, or pass workspaceStrategy.",
  });
  const commit = yield* git
    .execute({
      operation: "mcp.defaultWorktreeStrategy",
      cwd: workspaceRoot,
      // Not peeled: a branch whose tip object is missing still resolves, so only an unborn HEAD exits 1.
      args: ["rev-parse", "--verify", "--quiet", "HEAD"],
      allowNonZeroExit: true,
      timeoutMs: 5_000,
    })
    .pipe(Effect.orElseSucceed(() => null));
  // Only Git saying "no commit yet" (exit 1) or "not a repository" keeps the launch shared.
  if (commit?.exitCode === 1 || (commit !== null && NON_REPOSITORY_FATAL.test(commit.stderr)))
    return undefined;
  if (commit?.exitCode !== 0) return yield* unreadable;
  // symbolic-ref skips the index, so a held index lock cannot drop the launch into the shared checkout.
  const head = yield* git
    .execute({
      operation: "mcp.defaultWorktreeStrategy",
      cwd: workspaceRoot,
      args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
      allowNonZeroExit: true,
      timeoutMs: 5_000,
    })
    .pipe(Effect.orElseSucceed(() => null));
  if (head?.exitCode === 1) return undefined;
  const branch = head?.exitCode === 0 ? head.stdout.trim() : "";
  if (branch.length === 0) return yield* unreadable;
  return { type: "worktree" as const, baseRef: branch };
});

const access = Effect.gen(function* () {
  yield* readCaller();
  return yield* Project.ProjectService;
});
/**
 * Home watches the threads it launches. The watch is saved first; if it cannot be, the launch
 * does not run. A failed launch keeps its watch, since a relay timeout does not prove the thread
 * was not created; a watch whose thread never appears ends at the next start.
 */
const watchLaunched = (homeThreadId: ThreadId, environmentId: EnvironmentId, threadId: ThreadId) =>
  HomeService.HomeService.pipe(
    Effect.flatMap((home) =>
      home.updateWatches(homeThreadId, (current) =>
        HomeService.addWatch(current, { environmentId, threadId, reason: "launched" }),
      ),
    ),
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "Home could not watch the new thread, so it was not launched.",
        }),
    ),
  );

export const layer = McpToolAccess.toLayer(ProjectToolkit, {
  t3_thread_launch: McpToolAccess.startsThreads(
    (input) => input,
    (input, { runtimeMode, interactionMode, linkOrigin }) =>
      Effect.gen(function* () {
        const context = yield* readCaller();
        const { caller, scope } = context;
        // Home is always a thread caller; its id scopes the watches it saves.
        const homeThreadId = (yield* callerIsHome()) ? caller?.id : undefined;
        const isHome = homeThreadId !== undefined;
        const targetEnvironmentId = input.environmentId ?? scope.environmentId;
        const remote = targetEnvironmentId !== scope.environmentId;
        // Home's folder carries Home's own instructions, so nothing launches there.
        if (isHome && input.projectId === undefined && input.scratch !== true)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Home must pass projectId or scratch:true. Threads never launch in Home's folder.",
          });
        if (remote && !isHome)
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Only Home can act in another environment.",
          });
        if (input.job !== undefined && !isHome)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Only Home names a job. Omit job.",
          });
        const attachments = input.attachments ?? [];
        if (remote && attachments.length > 0)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Attachments cannot be sent to another environment.",
          });
        if (input.generateTitle === true && !input.message?.trim() && attachments.length === 0)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Title generation requires a message or attachments. No thread was created.",
          });
        const schemaProblem =
          input.outputSchema === undefined
            ? null
            : outputRequestProblem(input.outputSchema, {
                text: input.message ?? "",
                attachments: input.attachments,
              });
        if (schemaProblem !== null || (input.outputSchema !== undefined && !input.message))
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: schemaProblem ?? "outputSchema needs a message that asks for the result.",
          });
        if (attachments.some((attachment) => !Claims.attachmentIsPendingUpload(attachment)))
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "A new thread accepts only pending attachment uploads.",
          });
        if (
          input.scratch === true &&
          (input.projectId !== undefined || input.workspaceStrategy !== undefined)
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "scratch:true picks its own project and folder; omit projectId and workspaceStrategy.",
          });
        // Checked before the watch is saved, so a refused launch leaves no watch.
        // Another environment checks its own Home folder in FleetService.
        if (isHome && !remote && input.projectId !== undefined)
          yield* refuseHomeFolder(
            {
              projects: yield* Project.ProjectService,
              workspace: yield* HomeWorkspace.HomeWorkspace,
            },
            { projectId: input.projectId, workspaceStrategy: input.workspaceStrategy },
          );
        const commandId =
          input.clientRequestId === undefined
            ? yield* newCommandId()
            : yield* launchCommandId(scope.requestNamespace, input.clientRequestId);
        const threadId = ThreadId.make(
          isHome ? `${HOME_LAUNCHED_THREAD_ID_PREFIX}${commandId}` : commandId,
        );
        const messageId = MessageId.make(commandId);
        if (homeThreadId !== undefined && attachments.length === 0) {
          // Provider instances differ per machine, so another machine uses its own default.
          const modelSelection =
            input.modelSelection ?? (remote ? undefined : caller?.modelSelection);
          yield* watchLaunched(homeThreadId, targetEnvironmentId, threadId);
          return yield* runAsHome(input.environmentId, "threads.launch", {
            threadId,
            ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
            ...(input.scratch === undefined ? {} : { scratch: input.scratch }),
            title: input.title,
            ...(input.job === undefined ? {} : { job: input.job }),
            ...(modelSelection === undefined ? {} : { modelSelection }),
            runtimeMode,
            interactionMode,
            ...(input.workspaceStrategy === undefined
              ? {}
              : { workspaceStrategy: input.workspaceStrategy }),
            ...(input.message === undefined ? {} : { message: input.message }),
          });
        }
        const projectId =
          input.scratch === true
            ? (yield* ManagedProjectFolders.ManagedProjectFolders.pipe(
                Effect.flatMap((folders) => folders.ensureScratchProject),
                Effect.mapError(
                  (error) =>
                    new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: error.message,
                    }),
                ),
              )).projectId
            : yield* resolveProjectId(context, input.projectId);
        // A retry of an accepted launch replays it: it keeps the model it started
        // with and skips the checks only a new launch needs, which the project
        // may no longer pass, such as a base branch deleted since.
        const launched =
          input.clientRequestId === undefined
            ? null
            : yield* context.threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
        const launchedModel =
          launched === null || launched.deletedAt !== null ? undefined : launched.modelSelection;
        const replaying = launchedModel !== undefined;
        if (launched !== null && replaying && launched.projectId !== projectId)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "A launch retry must use the original project.",
          });
        const project =
          replaying && input.workspaceStrategy?.type !== "existing_worktree"
            ? undefined
            : yield* Project.ProjectService.pipe(
                Effect.flatMap((projects) => projects.getById(projectId)),
                Effect.mapError(unavailable),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(
                        new OrchestratorMcpFailure({
                          code: "invalid_request",
                          message: "The project was not found.",
                        }),
                      ),
                    onSome: Effect.succeed,
                  }),
                ),
              );
        const workspaceStrategy =
          project !== undefined && input.workspaceStrategy?.type === "existing_worktree"
            ? {
                ...input.workspaceStrategy,
                worktreePath: yield* projectWorktreePath(
                  project.workspaceRoot,
                  input.workspaceStrategy.worktreePath,
                ),
              }
            : input.workspaceStrategy;
        let validatedModelSelection = input.modelSelection;
        if (!replaying && input.modelSelection !== undefined) {
          const requestedSelection = input.modelSelection;
          const { instanceId, model } = requestedSelection;
          const registry = yield* ProviderRegistry.ProviderRegistry;
          // The thread runs in this folder, whose own provider config can add models.
          const cwd =
            workspaceStrategy?.type === "existing_worktree"
              ? workspaceStrategy.worktreePath
              : project?.workspaceRoot;
          const validateSelection = Effect.fn("mcp.validateLaunchModelSelection")(function* (
            providers: ReadonlyArray<ServerProvider>,
          ): Effect.fn.Return<ModelSelection, OrchestratorMcpFailure> {
            const provider = OrchestrationMcp.withWorkspaceModels(providers, cwd).find(
              (candidate) => candidate.instanceId === instanceId,
            );
            // Checked with the same provider snapshot that validates the options below.
            yield* refuseAgentModePick({
              callerRuntimeMode: context.limits.runtimeMode,
              picked: requestedSelection.options,
              descriptors: providerOptionDescriptors(provider),
              held:
                caller?.modelSelection.instanceId === instanceId
                  ? caller.modelSelection.options
                  : undefined,
            });
            if (provider === undefined) return requestedSelection;
            yield* OrchestrationMcp.requireAdvertisedModel(provider, model);
            const options = yield* OrchestrationMcp.validateModelOptions(
              provider,
              model,
              requestedSelection.options,
            );
            return options === undefined || options === requestedSelection.options
              ? requestedSelection
              : { ...requestedSelection, options };
          });
          const checked = validateSelection(yield* registry.getProviders);
          validatedModelSelection = yield* cwd === undefined
            ? checked
            : checked.pipe(
                Effect.catchIf(
                  (error) => error.code === "model_unavailable",
                  () =>
                    Project.ProjectService.pipe(
                      Effect.flatMap((projects) => projects.workspaceScanDirectory(cwd)),
                      Effect.flatMap((scanCwd) =>
                        registry.refreshWorkspaceSnapshot({ instanceId, cwd, scanCwd }),
                      ),
                      Effect.flatMap(validateSelection),
                    ),
                ),
              );
        }
        const projectSettings =
          replaying || project === undefined
            ? undefined
            : yield* ServerSettings.ServerSettingsService.pipe(
                Effect.flatMap((settings) => settings.getSettings),
                Effect.mapError(unavailable),
                Effect.map(
                  (settings) => resolveProjectSettings(settings, projectId, project).settings,
                ),
              );
        // An outside caller that names no workspace follows the new-threads-in-a-worktree
        // default, as the composer does.
        const requestedStrategy =
          workspaceStrategy === undefined &&
          caller === undefined &&
          project !== undefined &&
          projectSettings !== undefined &&
          (projectSettings.defaultThreadEnvMode ??
            (yield* projectFileThreadEnvMode(project.workspaceRoot))) === "worktree"
            ? yield* defaultWorktreeStrategy(project.workspaceRoot)
            : workspaceStrategy;
        // An omitted startFromOrigin follows the new-worktree setting, as the composer and
        // t3_worktree_handoff do. Otherwise a stale local branch silently becomes the base.
        const strategy =
          projectSettings !== undefined &&
          requestedStrategy?.type === "worktree" &&
          requestedStrategy.startFromOrigin === undefined
            ? {
                ...requestedStrategy,
                startFromOrigin: projectSettings.newWorktreesStartFromOrigin,
              }
            : requestedStrategy;
        // Reject unresolved base refs and blocked branch names before accepting a launch; worktree provisioning happens later.
        if (!replaying && strategy?.type === "worktree")
          yield* ThreadLaunch.ThreadLaunchService.pipe(
            Effect.flatMap((launches) =>
              launches.checkWorktreeBase({ projectId, workspaceStrategy: strategy }),
            ),
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: `${error.message} No thread was created. ${worktreeCheckHint(error, strategy)}`,
                }),
            ),
          );
        // A caller outside a thread has nothing to inherit, so it starts with the
        // project's effective defaults, as the composer does. Its mode stays
        // within the ceiling it was approved with.
        const projectDefaults = caller === undefined ? projectSettings : undefined;
        const modelSelection =
          validatedModelSelection ??
          launchedModel ??
          caller?.modelSelection ??
          (projectDefaults
            ? resolveNewThreadModelSelection({
                defaultSelection: projectDefaults.defaultModelSelection,
                fallbackSelection: projectDefaults.fallbackModelSelection,
                providers: yield* ProviderRegistry.ProviderRegistry.pipe(
                  Effect.flatMap((registry) => registry.getProviders),
                ),
                settings: projectDefaults,
                projectId,
                now: DateTime.toEpochMillis(yield* DateTime.now),
              }).selection
            : null) ??
          undefined;
        if (modelSelection === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
          });
        if (homeThreadId !== undefined)
          yield* watchLaunched(homeThreadId, scope.environmentId, threadId);
        let startedRuntimeMode =
          projectDefaults !== undefined && input.runtimeMode === undefined
            ? yield* resolveRuntimeMode(runtimeMode, projectDefaults.defaultRuntimeMode).pipe(
                Effect.orElseSucceed(() => runtimeMode),
              )
            : runtimeMode;
        if (!replaying) {
          const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
          startedRuntimeMode = yield* resolveRuntimeMode(startedRuntimeMode, input.runtimeMode, {
            modelSelection,
            supportedRuntimeModes: providers.find(
              (provider) => provider.instanceId === modelSelection.instanceId,
            )?.supportedRuntimeModes,
          });
        }
        const result = yield* ThreadMessageIntake.launchThread({
          commandId,
          threadId,
          projectId,
          title: input.title,
          ...(input.generateTitle === undefined ? {} : { generateTitle: input.generateTitle }),
          ...(input.generateTitle === true ? {} : { titleRenamed: true }),
          modelSelection,
          runtimeMode: startedRuntimeMode,
          interactionMode,
          workspaceStrategy: strategy ?? { type: "root" },
          ...(input.message === undefined && attachments.length === 0
            ? {}
            : {
                initialMessage: {
                  messageId,
                  ...(caller === undefined ? {} : { senderThreadId: caller.id }),
                  text: input.message ?? "",
                  attachments,
                  ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
                },
              }),
          createdBy: "agent",
          creationSource: "mcp",
          ...(linkOrigin === undefined ? {} : { linkOrigin }),
          // Kept only alongside linkOrigin: thread.create drops it otherwise.
          ...(input.delegatedFrom === undefined ? {} : { delegatedFrom: input.delegatedFrom }),
          ...(input.job === undefined ? {} : { homeJob: input.job }),
          // A link's word for it, like `delegatedFrom`: nothing else may name a run.
          ...(linkOrigin === undefined || input.workflowRun === undefined
            ? {}
            : { workflowRun: input.workflowRun }),
        }).pipe(
          Effect.mapError((error) => {
            if (error._tag === "AttachmentClaimError") {
              return new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: error.message,
              });
            }
            if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
              return new OrchestratorMcpFailure({
                code: "invalid_request",
                message: error.message,
              });
            }
            // The administrator's ceiling refuses the mode; say so rather than "unavailable".
            if (error._tag === "ThreadLaunchError" && isAboveCeilingError(error.cause)) {
              return new OrchestratorMcpFailure({
                code: "invalid_request",
                message: error.cause.message,
              });
            }
            return unavailable();
          }),
        );
        const thread = result.projection.thread;
        const run = result.projection.runs.find((run) => run.userMessageId === messageId);
        return {
          threadId: thread.id,
          link: McpInvocationContext.threadLinkFor(scope, thread.id, thread.title),
          projectId: thread.projectId,
          modelSelection: thread.modelSelection,
          runId: run?.id ?? null,
          status: run?.status ?? null,
        };
      }),
    // The launched thread carries the caller's link, if it has one.
    "stamped",
  ),
  t3_project_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const routed = yield* routeHome(input.environmentId, "projects.list", input);
      if (Option.isSome(routed)) return routed.value;
      const projects = yield* access;
      // Identities are resolved: linked environments find this side's project by repository.
      const page = yield* projects
        .listPage({ cursor: input.cursor ?? 0, limit: input.limit ?? 20 })
        .pipe(Effect.mapError(unavailable));
      return { ...page, projects: page.projects.map(yield* withSavedProjectSettings) };
    }),
  ),
  t3_project_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      const result = yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(result))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      return (yield* withSavedProjectSettings)(result.value);
    }),
  ),
  t3_project_create: McpToolAccess.writesEnvironment(
    ({ environmentId, ...input }) =>
      Effect.gen(function* () {
        const routed = yield* routeHome(environmentId, "projects.create", input);
        if (Option.isSome(routed)) return routed.value;
        return yield* createProject(input);
      }),
    // Linked work may bring the repository it works in; an existing
    // registered workspace is still refused.
    { linkedCallers: "allowed" },
  ),
  t3_project_update: McpToolAccess.writesEnvironment(({ environmentId, ...input }) =>
    Effect.gen(function* () {
      const routed = yield* routeHome(environmentId, "projects.update", input);
      if (Option.isSome(routed)) return routed.value;
      return yield* updateProject(input);
    }),
  ),
  t3_project_delete: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      // Home archives and settles; it never deletes.
      if (yield* callerIsHome())
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Home cannot delete projects. Archive or settle their threads instead.",
        });
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      if (yield* folders.isScratchProject(input.projectId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            '"No project" is the built-in scratch project and cannot be deleted through MCP. The user can remove it in Settings.',
        });
      const projects = yield* Project.ProjectService;
      const clones = yield* ProjectCloneTracker.ProjectCloneTracker;
      return yield* mutateProjectWithClone(projects, clones, {
        ...input,
        type: "project.delete",
        commandId: yield* newCommandId(),
      }).pipe(Effect.mapError(projectFailure));
    }),
  ),
  t3_project_clone: McpToolAccess.writesEnvironment(
    ({ environmentId, ...input }) =>
      Effect.gen(function* () {
        const routed = yield* routeHome(environmentId, "projects.clone", input);
        if (Option.isSome(routed)) return routed.value;
        return yield* cloneProject(input);
      }),
    // An existing destination is never adopted.
    { linkedCallers: "allowed" },
  ),
});
