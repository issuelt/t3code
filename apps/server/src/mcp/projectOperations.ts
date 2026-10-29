/**
 * Project and search operations that both the MCP tools and Home's fleet operations run, so a
 * call reaching another environment through Home behaves like the same tool called there.
 */
import {
  type EnvironmentId,
  type FleetProjectCreateInput,
  type FleetThreadSearchInput,
  OrchestratorMcpFailure,
  ProjectId,
  type SourceControlCloneRepositoryInput,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Project from "../project/ProjectService.ts";
import * as Repositories from "../sourceControl/SourceControlRepositoryService.ts";
import { newCommandId, unavailable } from "./threadAccess.ts";

export function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectNotFoundError"
      ? "The project was not found."
      : error._tag === "ProjectConflictError"
        ? "The workspace is already registered to a project."
        : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

export const createProject = Effect.fn("mcp.createProject")(function* ({
  workspaceRoot,
  ...input
}: FleetProjectCreateInput) {
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
      ...project,
      ...(created.commitError === undefined ? {} : { commitError: created.commitError }),
    };
  }
  const commandId = yield* newCommandId();
  return yield* projects
    .create({ ...input, workspaceRoot, commandId, projectId: ProjectId.make(commandId) })
    .pipe(Effect.mapError(projectFailure));
});

export const cloneProject = Effect.fn("mcp.cloneProject")(function* (
  input: SourceControlCloneRepositoryInput,
) {
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
});

/** Links point at `environmentId`, the environment that ran the search. */
export const searchThreads = Effect.fn("mcp.searchThreads")(function* (
  input: FleetThreadSearchInput,
  environmentId: EnvironmentId,
) {
  const threadSearch = yield* ThreadSearch.ThreadSearch;
  const { matches } = yield* threadSearch.searchThreads(input).pipe(Effect.mapError(unavailable));
  return {
    matches: matches.map((match) => ({
      ...match,
      link: formatThreadLink(match.threadId, match.title, environmentId),
    })),
  };
});
