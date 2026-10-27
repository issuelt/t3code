import {
  type EnvironmentId,
  HOME_LAUNCHED_THREAD_ID_PREFIX,
  MessageId,
  ThreadId,
  OrchestratorMcpFailure,
  ProjectId,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import { refuseHomeFolder } from "../../../home/FleetService.ts";
import * as HomeService from "../../../home/HomeService.ts";
import * as HomeWorkspace from "../../../home/HomeWorkspace.ts";
import { callerIsHome, routeHome, runAsHome } from "../../homeRouting.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveRuntimeMode } from "../../OrchestratorMcpService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { newCommandId, readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { ProjectToolkit } from "./tools.ts";

function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectNotFoundError"
      ? "The project was not found."
      : error._tag === "ProjectConflictError"
        ? "The workspace is already registered to a project."
        : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

/** Require project worktrees so launches cannot target arbitrary host directories. */
const assertProjectWorktree = Effect.fn("mcp.assertProjectWorktree")(function* (
  workspaceRoot: string,
  worktreePath: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const real = (path: string) => fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));
  const worktrees = yield* git.listWorktreePaths(workspaceRoot).pipe(
    Effect.flatMap((paths) => Effect.forEach(paths, real)),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  if (!worktrees.includes(yield* real(worktreePath)))
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "worktreePath must be one of the project's git worktrees. t3_worktree_list shows them.",
    });
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
    (input, { runtimeMode, interactionMode }) =>
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
        const attachments = input.attachments ?? [];
        if (remote && attachments.length > 0)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Attachments cannot be sent to another environment.",
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
        const commandId = yield* newCommandId();
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
        const readProject = Project.ProjectService.pipe(
          Effect.flatMap((projects) => projects.getById(projectId)),
          Effect.mapError(unavailable),
          Effect.map(Option.getOrUndefined),
        );
        if (input.workspaceStrategy?.type === "existing_worktree") {
          const project = yield* readProject;
          if (project === undefined)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "The project was not found.",
            });
          yield* assertProjectWorktree(project.workspaceRoot, input.workspaceStrategy.worktreePath);
        }
        // Reject unresolved base refs before accepting a launch; worktree provisioning happens later.
        const strategy = input.workspaceStrategy;
        if (strategy?.type === "worktree")
          yield* ThreadLaunch.ThreadLaunchService.pipe(
            Effect.flatMap((launches) =>
              launches.checkWorktreeBase({ projectId, workspaceStrategy: strategy }),
            ),
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: `${error.message} No thread was created. Pass a branch, tag, or commit that exists there${
                    strategy.startFromOrigin === true
                      ? "; the project has no usable remote to fetch it from."
                      : ", or set startFromOrigin:true if it exists only on a remote."
                  }`,
                }),
            ),
          );
        // A caller outside a thread has nothing to inherit, so it starts with the
        // project's effective defaults, as the composer does. Its mode stays
        // within the ceiling it was approved with.
        const projectDefaults =
          caller === undefined
            ? yield* ServerSettings.ServerSettingsService.pipe(
                Effect.flatMap((settings) => settings.getSettings),
                Effect.mapError(unavailable),
                Effect.flatMap((settings) =>
                  Effect.map(
                    readProject,
                    (project) => resolveProjectSettings(settings, projectId, project).settings,
                  ),
                ),
              )
            : undefined;
        const modelSelection =
          input.modelSelection ??
          caller?.modelSelection ??
          projectDefaults?.defaultModelSelection ??
          undefined;
        if (modelSelection === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
          });
        if (homeThreadId !== undefined)
          yield* watchLaunched(homeThreadId, scope.environmentId, threadId);
        const startedRuntimeMode =
          projectDefaults !== undefined && input.runtimeMode === undefined
            ? yield* resolveRuntimeMode(runtimeMode, projectDefaults.defaultRuntimeMode).pipe(
                Effect.orElseSucceed(() => runtimeMode),
              )
            : runtimeMode;
        const result = yield* ThreadMessageIntake.launchThread({
          commandId,
          threadId,
          projectId,
          title: input.title,
          modelSelection,
          runtimeMode: startedRuntimeMode,
          interactionMode,
          workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
          ...(input.message === undefined && attachments.length === 0
            ? {}
            : {
                initialMessage: {
                  messageId,
                  ...(caller === undefined ? {} : { senderThreadId: caller.id }),
                  text: input.message ?? "",
                  attachments,
                },
              }),
          createdBy: "agent",
          creationSource: "mcp",
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
            return unavailable();
          }),
        );
        const thread = result.projection.thread;
        const run = result.projection.runs.find((run) => run.userMessageId === messageId);
        return {
          threadId: thread.id,
          link: formatThreadLink(thread.id, thread.title, scope.environmentId),
          projectId: thread.projectId,
          modelSelection: thread.modelSelection,
          runId: run?.id ?? null,
          status: run?.status ?? null,
        };
      }),
  ),
  t3_project_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const routed = yield* routeHome(input.environmentId, "projects.list", input);
      if (Option.isSome(routed)) return routed.value;
      const projects = yield* access;
      const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
      const rows = snapshot.projects.filter((project) => project.deletedAt === null);
      const start = input.cursor ?? 0,
        end = start + (input.limit ?? 20);
      return { projects: rows.slice(start, end), nextCursor: end < rows.length ? end : null };
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
      return result.value;
    }),
  ),
  t3_project_create: McpToolAccess.writesEnvironment(({ workspaceRoot, ...input }) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      if (workspaceRoot === undefined) {
        // Only updates record model defaults; reject defaults that creation would silently drop.
        if (
          input.scripts !== undefined ||
          input.createWorkspaceRootIfMissing !== undefined ||
          input.defaultModelSelection !== undefined
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "A project started from its title takes only a title; set scripts or defaultModelSelection afterwards with t3_project_update.",
          });
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const created = yield* folders
          .createNamedProject({ name: input.title })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
            ),
          );
        const project = yield* projects
          .getById(created.projectId)
          .pipe(
            Effect.mapError(unavailable),
            Effect.flatMap(
              Option.match({ onNone: () => Effect.fail(unavailable()), onSome: Effect.succeed }),
            ),
          );
        return {
          ...project,
          ...(created.commitError === undefined ? {} : { commitError: created.commitError }),
        };
      }
      const commandId = yield* newCommandId();
      return yield* projects
        .create({ ...input, workspaceRoot, commandId, projectId: ProjectId.make(commandId) })
        .pipe(Effect.mapError(projectFailure));
    }),
  ),
  t3_project_update: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      return yield* projects
        .update({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
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
      const projects = yield* Project.ProjectService;
      return yield* projects
        .delete({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
    }),
  ),
  t3_project_clone: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const repositories = yield* Repositories.SourceControlRepositoryService;
      return yield* repositories.cloneRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: error.detail,
            }),
        ),
      );
    }),
  ),
});
