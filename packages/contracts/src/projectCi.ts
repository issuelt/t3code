import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";

export const ProjectCiProvider = Schema.Literals(["github", "gitlab"]);
export const ProjectCiInput = Schema.Struct({
  projectId: ProjectId,
  remoteName: Schema.optional(Schema.String),
  provider: Schema.optional(ProjectCiProvider),
});
export type ProjectCiInput = typeof ProjectCiInput.Type;
export const ProjectCiRemote = Schema.Struct({
  name: Schema.String,
  host: Schema.String,
  repository: Schema.String,
  provider: Schema.NullOr(ProjectCiProvider),
});
export type ProjectCiRemote = typeof ProjectCiRemote.Type;
export const ProjectCiJob = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  url: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
});
export const ProjectCiRun = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  url: Schema.String,
  branch: Schema.NullOr(Schema.String),
  sha: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ProjectCiRun = typeof ProjectCiRun.Type;
export const ProjectCiRunInput = Schema.Struct({
  ...ProjectCiInput.fields,
  remoteName: Schema.String,
  runId: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
});
export type ProjectCiRunInput = typeof ProjectCiRunInput.Type;
export const ProjectCiRunDetails = Schema.Struct({
  ...ProjectCiRun.fields,
  jobs: Schema.Array(ProjectCiJob),
  jobsError: Schema.optional(
    Schema.Literals(["authentication", "request_failed", "invalid_response"]),
  ),
  jobsTruncated: Schema.Boolean,
});
export type ProjectCiRunDetails = typeof ProjectCiRunDetails.Type;
export const ProjectCiRunResult = Schema.Struct({
  run: ProjectCiRunDetails,
  fetchedAt: Schema.String,
});
export type ProjectCiRunResult = typeof ProjectCiRunResult.Type;
export const ProjectCiResult = Schema.Struct({
  remotes: Schema.Array(ProjectCiRemote),
  selectedRemote: Schema.NullOr(ProjectCiRemote),
  fetchedAt: Schema.String,
  runs: Schema.Array(ProjectCiRun),
  activeRunsIncomplete: Schema.optional(Schema.Boolean),
  activeRunsTruncated: Schema.optional(Schema.Boolean),
});
export type ProjectCiResult = typeof ProjectCiResult.Type;
export class ProjectCiError extends Schema.TaggedError<ProjectCiError>()("ProjectCiError", {
  reason: Schema.Literals([
    "project_not_found",
    "remote_not_found",
    "unsupported_provider",
    "authentication",
    "request_failed",
    "invalid_response",
  ]),
}) {
  override get message(): string {
    return `Could not read project CI (${this.reason}).`;
  }
}
