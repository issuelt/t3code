import {
  ProjectCiError,
  type ProjectCiInput,
  type ProjectCiRunInput,
  type ProjectCiRunResult,
  type ProjectCiRunDetails,
  type ProjectCiRemote,
  type ProjectCiResult,
} from "@t3tools/contracts";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as Redacted from "effect/Redacted";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProjectService from "../project/ProjectService.ts";
import { parseGitRemoteHost } from "@t3tools/source-control-core/shared/definition";
import { builtInSourceControlDefinitions } from "@t3tools/source-control-definitions/registry";
import { refineUnknownRemoteProvider } from "@t3tools/source-control-core/server/discovery";
import * as BuiltInDrivers from "./builtInDrivers.ts";

const gitlabEnvironment = { GITLAB_TOKEN: "", GITLAB_ACCESS_TOKEN: "", OAUTH_TOKEN: "" };

const nullableString = Schema.NullOr(Schema.String);
const githubRun = Schema.Struct({
  id: Schema.Number,
  html_url: Schema.optional(Schema.String),
  name: nullableString,
  status: nullableString,
  conclusion: nullableString,
  head_branch: nullableString,
  head_sha: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
});
const githubRuns = Schema.Struct({ workflow_runs: Schema.Array(githubRun) });
const githubJobs = Schema.Struct({
  jobs: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      html_url: Schema.optional(Schema.String),
      name: Schema.String,
      status: Schema.String,
      conclusion: nullableString,
      started_at: nullableString,
      completed_at: nullableString,
    }),
  ),
});
const gitlabRun = Schema.Struct({
  id: Schema.Number,
  web_url: Schema.optional(Schema.String),
  status: Schema.String,
  ref: Schema.String,
  sha: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
});
const gitlabRuns = Schema.Array(gitlabRun);
const gitlabJobs = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    web_url: Schema.optional(Schema.String),
    name: Schema.String,
    status: Schema.String,
    started_at: nullableString,
    finished_at: nullableString,
  }),
);

function parseRemote(
  name: string,
  raw: string,
): { remote: ProjectCiRemote; origin: string } | null {
  const trimmed = raw.trim();
  const scp = !trimmed.includes("://") && /^(?:[^@/:\s]+@)?([^@/:\s]{2,}):([^\s]+)$/.exec(trimmed);
  const normalized = scp ? `ssh://${scp[1]}/${scp[2]}` : trimmed;
  const parsedHost = parseGitRemoteHost(normalized);
  if (!parsedHost) return null;
  let url: URL;
  try {
    url = new URL(normalized);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null;
  } catch {
    return null;
  }
  const host = parsedHost.host;
  const repository = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (
    !/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(host) ||
    !/^[\w.-]+(?:\/[\w.-]+)+$/.test(repository) ||
    repository.split("/").some((part) => part === "." || part === "..")
  )
    return null;
  const provider = builtInSourceControlDefinitions.recognizeRemote(normalized)?.kind;
  return {
    remote: {
      name,
      host,
      repository,
      provider: provider === "github" ? "github" : provider === "gitlab" ? "gitlab" : null,
    },
    origin: `${url.protocol === "http:" ? "http:" : "https:"}//${host}`,
  };
}

export class ProjectCi extends Context.Service<
  ProjectCi,
  {
    readonly read: (input: ProjectCiInput) => Effect.Effect<ProjectCiResult, ProjectCiError>;
    readonly readRun: (
      input: ProjectCiRunInput,
    ) => Effect.Effect<ProjectCiRunResult, ProjectCiError>;
  }
>()("t3/sourceControl/ProjectCi") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const host = yield* SourceControlHost.SourceControlHost;
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const drivers = yield* BuiltInDrivers.SourceControlDrivers;
  const resolve = Effect.fn("ProjectCi.resolve")(function* (input: ProjectCiInput) {
    const project = yield* projects
      .getById(input.projectId)
      .pipe(Effect.mapError(() => new ProjectCiError({ reason: "request_failed" })));
    if (Option.isNone(project)) return yield* new ProjectCiError({ reason: "project_not_found" });
    const cwd = project.value.workspaceRoot;
    const getRemotes = yield* host.git
      .remotes(cwd)
      .pipe(Effect.mapError(() => new ProjectCiError({ reason: "request_failed" })));
    const result = yield* getRemotes.pipe(
      Effect.mapError(() => new ProjectCiError({ reason: "request_failed" })),
    );
    const parsedRemotes = yield* Effect.forEach(result.remotes, (remote) =>
      Effect.gen(function* () {
        const parsed = parseRemote(remote.name, remote.url);
        if (!parsed) return [];
        if (
          parsed.remote.provider === null &&
          !input.provider &&
          (!input.remoteName || input.remoteName === remote.name)
        ) {
          const contextProvider = builtInSourceControlDefinitions.recognizeRemote(parsed.origin);
          if (contextProvider?.kind === "unknown") {
            const verdict = yield* refineUnknownRemoteProvider({
              specs: drivers
                .filter(({ driver }) => driver.kind === "gitlab")
                .map(({ instance }) => instance.discovery),
              process: { run: (input) => host.process.run({ ...input, env: gitlabEnvironment }) },
              cwd,
              context: {
                provider: contextProvider,
                remoteName: remote.name,
                remoteUrl: parsed.origin,
              },
            });
            if (verdict.provider?.kind === "gitlab")
              return [{ ...parsed, remote: { ...parsed.remote, provider: "gitlab" as const } }];
          }
        }
        return [parsed];
      }),
    ).pipe(Effect.map((entries) => entries.flat()));
    const remotes = parsedRemotes.map(({ remote }) => remote);
    const parsedSelected = input.remoteName
      ? parsedRemotes.find(({ remote }) => remote.name === input.remoteName)
      : undefined;
    if (input.remoteName && !parsedSelected)
      return yield* new ProjectCiError({ reason: "remote_not_found" });
    return { remotes, parsedSelected, cwd };
  });
  const connect = Effect.fn("ProjectCi.connect")(function* (
    input: ProjectCiInput,
    parsedSelected: NonNullable<ReturnType<typeof parseRemote>>,
    cwd: string,
  ) {
    const { remote: selected, origin } = parsedSelected;
    const provider = input.provider ?? selected.provider;
    if (!provider) return yield* new ProjectCiError({ reason: "unsupported_provider" });
    const selectedRemote = { ...selected, provider };
    const base = `${origin}/${selected.repository}`;
    const apiBase = (url: string | undefined) => {
      if (!url) return base;
      try {
        const parsed = new URL(url);
        const expected = new URL(origin);
        if (
          (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
          parsed.hostname !== expected.hostname
        )
          return base;
        return `${parsed.origin}/${selected.repository}`;
      } catch {
        return base;
      }
    };
    const credential =
      provider === "github"
        ? yield* credentials
            .get(selected.host)
            .pipe(Effect.mapError(() => new ProjectCiError({ reason: "authentication" })))
        : null;
    const api = (endpoint: string) =>
      host.process
        .run({
          operation: "ProjectCi.read",
          command: provider === "github" ? "gh" : "glab",
          args: ["api", "--hostname", selected.host, endpoint],
          cwd,
          ...(credential
            ? {
                env: {
                  GH_TOKEN:
                    selected.host === "github.com" || selected.host.endsWith(".ghe.com")
                      ? Redacted.value(credential.token)
                      : "",
                  GITHUB_TOKEN: "",
                  GH_ENTERPRISE_TOKEN:
                    selected.host === "github.com" || selected.host.endsWith(".ghe.com")
                      ? ""
                      : Redacted.value(credential.token),
                  GITHUB_ENTERPRISE_TOKEN: "",
                  GH_PROMPT_DISABLED: "1",
                },
              }
            : { env: gitlabEnvironment }),
          concurrency:
            provider === "github"
              ? GitHubCredentials.GH_PROCESS_CONCURRENCY
              : { key: `glab:${selected.host}`, limit: 3 },
          timeoutMs: 15_000,
          maxOutputBytes: 1024 * 1024,
          classifyFailure: (stderr) =>
            /glab auth login|not authenticated|\b401\b/i.test(stderr) ? "authentication" : null,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new ProjectCiError({
                reason:
                  error._tag === "VcsProcessExitError" && error.failureKind === "authentication"
                    ? "authentication"
                    : "request_failed",
              }),
          ),
        );
    return { api, apiBase, selectedRemote, provider, selected };
  });
  const decode = <A, I>(schema: Schema.Codec<A, I>, raw: string) =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
      Effect.mapError(() => new ProjectCiError({ reason: "invalid_response" })),
    );
  const githubSummary = (
    run: typeof githubRun.Type,
    apiBase: (url: string | undefined) => string,
  ) => ({
    id: String(run.id),
    name: run.name ?? "Workflow",
    status: run.status ?? "unknown",
    conclusion: run.conclusion,
    url: `${apiBase(run.html_url)}/actions/runs/${run.id}`,
    branch: run.head_branch,
    sha: run.head_sha,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  });
  const gitlabSummary = (
    run: typeof gitlabRun.Type,
    apiBase: (url: string | undefined) => string,
  ) => ({
    id: String(run.id),
    name: "Pipeline",
    status: run.status,
    conclusion: null,
    url: `${apiBase(run.web_url)}/-/pipelines/${run.id}`,
    branch: run.ref,
    sha: run.sha,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  });
  const read = Effect.fn("ProjectCi.read")(function* (input: ProjectCiInput) {
    const { remotes, parsedSelected, cwd } = yield* resolve(input);
    const fetchedAt = DateTime.formatIso(yield* DateTime.now);
    if (!parsedSelected) return { remotes, selectedRemote: null, fetchedAt, runs: [] };
    const { api, apiBase, provider, selected, selectedRemote } = yield* connect(
      input,
      parsedSelected,
      cwd,
    );
    const collectRuns = Effect.fn("ProjectCi.collectRuns")(function* <
      A extends { readonly id: number },
    >(
      recent: ReadonlyArray<A>,
      statuses: ReadonlyArray<string>,
      fetchPage: (status: string, page: number) => Effect.Effect<ReadonlyArray<A>, ProjectCiError>,
    ) {
      const collected = new Map(recent.slice(0, 10).map((run) => [run.id, run]));
      let activeRunsTruncated = false;
      let activeRunsIncomplete = false;
      for (const status of statuses) {
        for (let page = 1; page <= 5; page++) {
          const result = yield* fetchPage(status, page).pipe(Effect.result);
          if (result._tag === "Failure") {
            activeRunsIncomplete = true;
            break;
          }
          const active = result.success;
          for (const run of active) collected.set(run.id, run);
          if (active.length < 100) break;
          if (page === 5) activeRunsTruncated = true;
        }
      }
      return { data: [...collected.values()], activeRunsTruncated, activeRunsIncomplete };
    });
    if (provider === "github") {
      const response = yield* api(`repos/${selected.repository}/actions/runs?per_page=10`);
      const data = yield* decode(githubRuns, response.stdout);
      const collected = yield* collectRuns(
        data.workflow_runs,
        ["queued", "in_progress", "waiting", "requested", "pending"],
        (status, page) =>
          api(
            `repos/${selected.repository}/actions/runs?status=${status}&per_page=100&page=${page}`,
          ).pipe(
            Effect.flatMap((response) => decode(githubRuns, response.stdout)),
            Effect.map((data) => data.workflow_runs),
          ),
      );
      const runs = collected.data.map((run) => githubSummary(run, apiBase));
      return {
        remotes,
        selectedRemote,
        fetchedAt,
        runs,
        activeRunsTruncated: collected.activeRunsTruncated,
        activeRunsIncomplete: collected.activeRunsIncomplete,
      };
    }
    const projectPath = encodeURIComponent(selected.repository);
    const response = yield* api(`projects/${projectPath}/pipelines?per_page=10`);
    const data = yield* decode(gitlabRuns, response.stdout);
    const collected = yield* collectRuns(
      data,
      ["created", "waiting_for_resource", "preparing", "pending", "running"],
      (status, page) =>
        api(`projects/${projectPath}/pipelines?status=${status}&per_page=100&page=${page}`).pipe(
          Effect.flatMap((response) => decode(gitlabRuns, response.stdout)),
        ),
    );
    const runs = collected.data.map((run) => gitlabSummary(run, apiBase));
    return {
      remotes,
      selectedRemote,
      fetchedAt,
      runs,
      activeRunsTruncated: collected.activeRunsTruncated,
      activeRunsIncomplete: collected.activeRunsIncomplete,
    };
  });
  const readRun = Effect.fn("ProjectCi.readRun")(function* (input: ProjectCiRunInput) {
    const { parsedSelected, cwd } = yield* resolve(input);
    if (!parsedSelected) return yield* new ProjectCiError({ reason: "remote_not_found" });
    const { api, apiBase, provider, selected } = yield* connect(input, parsedSelected, cwd);
    const endpoint =
      provider === "github"
        ? `repos/${selected.repository}/actions/runs/${input.runId}`
        : `projects/${encodeURIComponent(selected.repository)}/pipelines/${input.runId}`;
    const response = yield* api(endpoint);
    const run =
      provider === "github"
        ? githubSummary(yield* decode(githubRun, response.stdout), apiBase)
        : gitlabSummary(yield* decode(gitlabRun, response.stdout), apiBase);
    const jobs: Array<ProjectCiRunDetails["jobs"][number]> = [];
    let jobsError: ProjectCiRunDetails["jobsError"];
    let jobsTruncated = false;
    for (let page = 1; page <= 5; page++) {
      const result = yield* api(`${endpoint}/jobs?per_page=100&page=${page}`).pipe(
        Effect.flatMap((response) =>
          provider === "github"
            ? decode(githubJobs, response.stdout).pipe(
                Effect.map((data) =>
                  data.jobs.map((job) => ({
                    name: job.name,
                    status: job.status,
                    conclusion: job.conclusion,
                    url: `${apiBase(job.html_url ?? run.url)}/actions/runs/${input.runId}/job/${job.id}`,
                    startedAt: job.started_at,
                    completedAt: job.completed_at,
                  })),
                ),
              )
            : decode(gitlabJobs, response.stdout).pipe(
                Effect.map((data) =>
                  data.map((job) => ({
                    name: job.name,
                    status: job.status,
                    conclusion: null,
                    url: `${apiBase(job.web_url ?? run.url)}/-/jobs/${job.id}`,
                    startedAt: job.started_at,
                    completedAt: job.finished_at,
                  })),
                ),
              ),
        ),
        Effect.result,
      );
      if (result._tag === "Failure") {
        const reason = result.failure.reason;
        jobsError =
          reason === "authentication" || reason === "invalid_response" ? reason : "request_failed";
        break;
      }
      jobs.push(...result.success);
      if (result.success.length < 100) break;
      if (page === 5) jobsTruncated = true;
    }
    return {
      run: { ...run, jobs, jobsTruncated, ...(jobsError ? { jobsError } : {}) },
      fetchedAt: DateTime.formatIso(yield* DateTime.now),
    };
  });
  return ProjectCi.of({ read, readRun });
});
export const layer = Layer.effect(ProjectCi, make);
