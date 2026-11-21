/**
 * Project and search operations that both the MCP tools and Home's fleet operations run, so a
 * call reaching another environment through Home behaves like the same tool called there.
 */
import {
  type EnvironmentId,
  type FleetProjectCreateInput,
  type FleetProjectUpdateInput,
  type FleetThreadSearchInput,
  OrchestratorMcpFailure,
  type Project as ProjectRecord,
  ProjectId,
  type SourceControlCloneRepositoryInput,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Project from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Repositories from "../sourceControl/SourceControlRepositoryService.ts";
import { newCommandId, unavailable } from "./threadAccess.ts";

export function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectInvalidError"
      ? error.detail
      : error._tag === "ProjectNotFoundError"
        ? "The project was not found."
        : error._tag === "ProjectConflictError"
          ? "The workspace is already registered to a project."
          : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

/** Settings, not the project record, hold the default model and actions that new threads use. */
export const withSavedProjectSettings = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService.pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.mapError(unavailable),
  );
  return (project: ProjectRecord) => {
    const resolved = resolveProjectSettings(settings, project.id, project);
    return {
      ...project,
      defaultModelSelection:
        resolved.sources.defaultModelSelection === "project"
          ? resolved.settings.defaultModelSelection
          : null,
      scripts: resolveProjectScripts(settings, project),
    };
  };
});

// The project is already committed, so a failed Settings read must not report the create as failed.
const withSavedProjectSettingsAfterCreate = withSavedProjectSettings.pipe(
  Effect.orElseSucceed(() => (project: ProjectRecord) => project),
);

export const createProject = Effect.fn("mcp.createProject")(function* ({
  workspaceRoot,
  ...input
}: FleetProjectCreateInput) {
  const projects = yield* Project.ProjectService;
  if (workspaceRoot === undefined) {
    // Only updates record model defaults; reject defaults that creation would silently drop.
    if (
      input.scripts !== undefined ||
      input.trackedFolders !== undefined ||
      input.createWorkspaceRootIfMissing !== undefined ||
      input.defaultModelSelection !== undefined
    )
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message:
          "A project started from its title takes only a title; set scripts or defaultModelSelection afterwards with t3_project_update.",
      });
    const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const created = yield* folders.createNamedProject({ name: input.title }).pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: error.message,
          }),
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
      ...(yield* withSavedProjectSettingsAfterCreate)(project),
      ...(created.commitError === undefined ? {} : { commitError: created.commitError }),
    };
  }
  if (input.defaultModelSelection !== undefined && input.defaultModelSelection !== null)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "Creating a project does not set its default model; set defaultModelSelection afterwards with t3_project_update.",
    });
  const commandId = yield* newCommandId();
  const created = yield* projects
    .create({ ...input, workspaceRoot, commandId, projectId: ProjectId.make(commandId) })
    .pipe(Effect.mapError(projectFailure));
  return (yield* withSavedProjectSettingsAfterCreate)(created);
});

export const updateProject = Effect.fn("mcp.updateProject")(function* (
  input: FleetProjectUpdateInput,
) {
  const projects = yield* Project.ProjectService;
  const updated = yield* projects
    .update({ ...input, commandId: yield* newCommandId() })
    .pipe(Effect.mapError(projectFailure));
  return (yield* withSavedProjectSettings)(updated);
});

export const cloneProject = Effect.fn("mcp.cloneProject")(function* (
  input: SourceControlCloneRepositoryInput,
) {
  const repositories = yield* Repositories.SourceControlRepositoryService;
  // Agents' MCP calls have their own long budget, and an aborted call interrupts git.
  return yield* repositories.cloneRepository(input, { timeoutMs: null }).pipe(
    Effect.mapError(
      (error) =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: error.detail,
        }),
    ),
  );
});

/** Links point at `environmentId`, the environment that ran the search. */
export const searchThreads = Effect.fn("mcp.searchThreads")(function* (
  input: FleetThreadSearchInput,
  {
    environmentId,
    currentThreadId,
  }: { environmentId: EnvironmentId; currentThreadId: ThreadId | null },
) {
  const threadSearch = yield* ThreadSearch.ThreadSearch;
  const { matches } = yield* threadSearch.searchThreads(input).pipe(Effect.mapError(unavailable));
  return {
    currentThreadId,
    matches: matches.map((match) => ({
      ...match,
      link: formatThreadLink({ environmentId, threadId: match.threadId }, match.title),
    })),
  };
});
