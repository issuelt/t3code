import {
  DEFAULT_SERVER_SETTINGS,
  Project,
  ProjectId,
  TrimmedNonEmptyString,
  VcsProcessExitError,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitLabDriver from "@t3tools/source-control-gitlab/server/driver";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { assert, it } from "@effect/vitest";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectCi from "./ProjectCi.ts";
import * as BuiltInDrivers from "./builtInDrivers.ts";

const projectId = ProjectId.make("project-ci");
const project = Schema.decodeSync(Project)({
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});
const remote = (name: string, url: string) => ({
  name: TrimmedNonEmptyString.make(name),
  url: TrimmedNonEmptyString.make(url),
  pushUrl: Option.none(),
  isPrimary: name === "origin",
});
const rawRun = {
  id: 42,
  name: "CI",
  status: "completed",
  conclusion: "failure",
  head_branch: "main",
  head_sha: "abc",
  created_at: "now",
  updated_at: "now",
};
const output = (body: unknown) =>
  Effect.succeed(TestSourceControlHost.processOutput(JSON.stringify(body)));
type Respond = (
  endpoint: string,
) => Effect.Effect<SourceControlHost.SourceControlProcessOutput, VcsProcessExitError>;

function harness(
  url: string,
  respond: Respond,
  options: {
    status?: number;
    http?: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<Response>;
  } = {},
) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const processes: SourceControlHost.SourceControlProcessInput[] = [];
  const host = new URL(url.replace(/^git@([^:]+):/, "https://$1/")).hostname.toLowerCase();
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push(request);
      const endpoint =
        new URL(request.url).pathname.replace(/^\/api\/v3\//, "").replace(/^\//, "") +
        new URL(request.url).search;
      return (
        options.http
          ? options.http(request)
          : respond(endpoint).pipe(
              Effect.match({
                onFailure: () => new Response("secret", { status: 500 }),
                onSuccess: (answer) =>
                  new Response(answer.stdout, { status: options.status ?? 200 }),
              }),
            )
      ).pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response)));
    }),
  );
  const hostLayer = TestSourceControlHost.layer({
    settings: applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      sourceControlHosts: {
        github: { hosts: { [host]: { enabled: true } }, tokens: { [host]: "saved-token" } },
      },
    }),
    git: {
      remotes: () =>
        Effect.succeed(
          Effect.succeed({
            remotes: [remote("origin", url)],
            freshness: {
              source: "live-local",
              observedAt: DateTime.makeUnsafe(0),
              expiresAt: Option.none(),
            },
          }),
        ),
    },
    process: {
      run: (input) => {
        processes.push(input);
        if (input.command !== "glab")
          return Effect.fail(
            new VcsProcessExitError({
              operation: "api",
              command: input.command,
              cwd: "/repo",
              exitCode: 1,
              detail: "gh unavailable",
            }),
          );
        return respond(input.args[3] ?? "");
      },
    },
  });
  const dependencies = Layer.mergeAll(
    hostLayer,
    http,
    NodeServices.layer,
    SourceControlRateLimit.layer,
  );
  const drivers = Layer.effect(
    BuiltInDrivers.SourceControlDrivers,
    Effect.scoped(GitLabDriver.driver.make).pipe(
      Effect.map((instance) => [{ driver: GitLabDriver.driver, instance }]),
    ),
  );
  const layer = ProjectCi.layer.pipe(
    Layer.provideMerge(GitHubRest.layerWithDependencies),
    Layer.provide(drivers),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedSome(project) }),
    ),
    Layer.provide(dependencies),
  );
  return { layer, requests, processes };
}
const fixtureLayer = (url: string, respond: Respond) => harness(url, respond).layer;
const readFixture = (
  url: string,
  respond: Respond,
  input: { remoteName?: string; provider?: "github" | "gitlab" } = {},
) =>
  Effect.gen(function* () {
    const ci = yield* ProjectCi.ProjectCi;
    return yield* ci.read({ projectId, ...input });
  }).pipe(Effect.provide(fixtureLayer(url, respond)));

const ciLayer = ProjectCi.layer.pipe(
  Layer.provide(
    Layer.effect(
      BuiltInDrivers.SourceControlDrivers,
      Effect.scoped(GitLabDriver.driver.make).pipe(
        Effect.map((instance) => [{ driver: GitLabDriver.driver, instance }]),
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, SourceControlRateLimit.layer),
        ),
      ),
    ),
  ),
);

const remotes = {
  remotes: [
    remote("origin", "git@github.com:Owner/Repo.git"),
    remote("upstream", "git@code.example.test:Group/Nested/Repo.git"),
  ],
  freshness: {
    source: "live-local" as const,
    observedAt: DateTime.makeUnsafe(0),
    expiresAt: Option.none(),
  },
};

it.effect("reads the selected nested GitLab remote with host-qualified requests", () =>
  Effect.gen(function* () {
    const calls: string[][] = [];
    const layer = ciLayer.pipe(
      Layer.provide(Layer.mock(GitHubRest.GitHubRest)({})),
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedSome(project) }),
      ),
      Layer.provide(
        TestSourceControlHost.layer({
          git: { remotes: () => Effect.succeed(Effect.succeed(remotes)) },
          process: {
            run: (input) => {
              calls.push([...input.args]);
              return Effect.succeed(
                TestSourceControlHost.processOutput(
                  input.args[3]?.includes("/jobs?")
                    ? JSON.stringify([
                        {
                          id: 2,
                          name: "test",
                          status: "failed",
                          started_at: null,
                          finished_at: null,
                        },
                      ])
                    : JSON.stringify([
                        {
                          id: 1,
                          status: "failed",
                          ref: "main",
                          sha: "abc",
                          created_at: "now",
                          updated_at: "now",
                        },
                      ]),
                ),
              );
            },
          },
        }),
      ),
    );
    const result = yield* Effect.gen(function* () {
      const ci = yield* ProjectCi.ProjectCi;
      return yield* ci.read({ projectId, remoteName: "upstream", provider: "gitlab" });
    }).pipe(Effect.provide(layer));
    assert.strictEqual(
      result.runs[0]?.url,
      "https://code.example.test/Group/Nested/Repo/-/pipelines/1",
    );
    assert.deepStrictEqual(calls[0], [
      "api",
      "--hostname",
      "code.example.test",
      "projects/Group%2FNested%2FRepo/pipelines?per_page=10",
    ]);
    assert.deepStrictEqual(
      calls.find((args) => args[3]?.includes("/jobs?")),
      undefined,
    );
  }),
);

it.effect("reports authentication failures without returning CLI output", () =>
  Effect.gen(function* () {
    const layer = ciLayer.pipe(
      Layer.provide(Layer.mock(GitHubRest.GitHubRest)({})),
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedSome(project) }),
      ),
      Layer.provide(
        TestSourceControlHost.layer({
          git: { remotes: () => Effect.succeed(Effect.succeed(remotes)) },
          process: {
            run: () =>
              Effect.fail(
                new VcsProcessExitError({
                  operation: "api",
                  command: "glab",
                  cwd: "/repo",
                  exitCode: 1,
                  failureKind: "authentication",
                  detail: "secret",
                }),
              ),
          },
        }),
      ),
    );
    const error = yield* Effect.gen(function* () {
      const ci = yield* ProjectCi.ProjectCi;
      return yield* ci.read({ projectId, remoteName: "upstream", provider: "gitlab" });
    }).pipe(Effect.provide(layer), Effect.flip);
    assert.strictEqual(error.reason, "authentication");
    assert.notInclude(error.message, "secret");
  }),
);

it.effect("discovers remotes using host-specific authentication probes only", () =>
  Effect.gen(function* () {
    const layer = ciLayer.pipe(
      Layer.provide(Layer.mock(GitHubRest.GitHubRest)({})),
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedSome(project) }),
      ),
      Layer.provide(
        TestSourceControlHost.layer({
          git: { remotes: () => Effect.succeed(Effect.succeed(remotes)) },
          process: {
            run: (input) => {
              assert.deepStrictEqual(input.args, [
                "auth",
                "status",
                "--hostname",
                "code.example.test",
              ]);
              return Effect.succeed(
                TestSourceControlHost.processOutput("No GitLab instances have been authenticated."),
              );
            },
          },
        }),
      ),
    );
    const result = yield* Effect.gen(function* () {
      const ci = yield* ProjectCi.ProjectCi;
      return yield* ci.read({ projectId });
    }).pipe(Effect.provide(layer));
    assert.deepStrictEqual(result.remotes, [
      { name: "origin", host: "github.com", repository: "Owner/Repo", provider: "github" },
      {
        name: "upstream",
        host: "code.example.test",
        repository: "Group/Nested/Repo",
        provider: null,
      },
    ]);
    assert.isNull(result.selectedRemote);
    assert.deepStrictEqual(result.runs, []);
  }),
);

it.effect("preserves HTTP remote ports in run summaries", () =>
  Effect.gen(function* () {
    const calls: string[][] = [];
    const layer = ciLayer.pipe(
      Layer.provide(Layer.mock(GitHubRest.GitHubRest)({})),
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedSome(project) }),
      ),
      Layer.provide(
        TestSourceControlHost.layer({
          git: {
            remotes: () =>
              Effect.succeed(
                Effect.succeed({
                  ...remotes,
                  remotes: [
                    remote("origin", "http://user:secret@code.example.test:8080/Group/Repo.git"),
                  ],
                }),
              ),
          },
          process: {
            run: (input) => {
              calls.push([...input.args]);
              return input.args[3]?.includes("/jobs?")
                ? Effect.fail(
                    new VcsProcessExitError({
                      operation: "api",
                      command: "glab",
                      cwd: "/repo",
                      exitCode: 1,
                      detail: "secret",
                    }),
                  )
                : Effect.succeed(
                    TestSourceControlHost.processOutput(
                      JSON.stringify([
                        {
                          id: 1,
                          status: "failed",
                          ref: "main",
                          sha: "abc",
                          created_at: "now",
                          updated_at: "now",
                        },
                      ]),
                    ),
                  );
            },
          },
        }),
      ),
    );
    const result = yield* Effect.gen(function* () {
      const ci = yield* ProjectCi.ProjectCi;
      return yield* ci.read({ projectId, remoteName: "origin", provider: "gitlab" });
    }).pipe(Effect.provide(layer));
    assert.strictEqual(
      result.runs[0]?.url,
      "http://code.example.test:8080/Group/Repo/-/pipelines/1",
    );
    assert.isFalse(calls.some((args) => args[3]?.includes("/jobs?")));
    assert.strictEqual(calls[0]?.[2], "code.example.test:8080");
    assert.notInclude(JSON.stringify(result), "secret");
  }),
);

it.effect("uses the API web origin for an SSH remote with a separate SSH port", () =>
  Effect.gen(function* () {
    const layer = ciLayer.pipe(
      Layer.provide(Layer.mock(GitHubRest.GitHubRest)({})),
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedSome(project) }),
      ),
      Layer.provide(
        TestSourceControlHost.layer({
          git: {
            remotes: () =>
              Effect.succeed(
                Effect.succeed({
                  ...remotes,
                  remotes: [remote("origin", "ssh://git@code.example.test:2222/Group/Repo.git")],
                }),
              ),
          },
          process: {
            run: (input) =>
              Effect.succeed(
                TestSourceControlHost.processOutput(
                  input.args[3]?.includes("/jobs?")
                    ? "[]"
                    : JSON.stringify([
                        {
                          id: 1,
                          status: "success",
                          ref: "main",
                          sha: "abc",
                          created_at: "now",
                          updated_at: "now",
                          web_url:
                            "http://user:secret@code.example.test:8080/Group/Repo/-/pipelines/1?token=secret",
                        },
                      ]),
                ),
              ),
          },
        }),
      ),
    );
    const result = yield* Effect.gen(function* () {
      const ci = yield* ProjectCi.ProjectCi;
      return yield* ci.read({ projectId, remoteName: "origin", provider: "gitlab" });
    }).pipe(Effect.provide(layer));
    assert.strictEqual(result.selectedRemote?.host, "code.example.test");
    assert.strictEqual(
      result.runs[0]?.url,
      "http://code.example.test:8080/Group/Repo/-/pipelines/1",
    );
    assert.notInclude(JSON.stringify(result), "secret");
  }),
);

it.live("isolates ambient GitLab tokens in the spawned process", () =>
  Effect.gen(function* () {
    const names = [
      "GITLAB_TOKEN",
      "GITLAB_ACCESS_TOKEN",
      "OAUTH_TOKEN",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) process.env[name] = `ambient-${name}`;
    try {
      const environments: Array<{ command: string; env: Record<string, string | undefined> }> = [];
      const hostLayer = Layer.effect(
        SourceControlHost.SourceControlHost,
        Effect.gen(function* () {
          const host = yield* SourceControlHost.SourceControlHost;
          return SourceControlHost.SourceControlHost.of({
            ...host,
            process: {
              run: (input) =>
                host.process
                  .run({
                    ...input,
                    command: process.execPath,
                    args: [
                      "-e",
                      `process.stdout.write(JSON.stringify(${JSON.stringify(names)}.reduce((env, name) => ({ ...env, [name]: process.env[name] }), {})))`,
                    ],
                    cwd: process.cwd(),
                  })
                  .pipe(
                    Effect.map((output) => {
                      environments.push({ command: input.command, env: JSON.parse(output.stdout) });
                      return {
                        ...output,
                        stdout: input.command === "glab" ? "[]" : '{"workflow_runs":[]}',
                      };
                    }),
                  ),
            },
          });
        }),
      ).pipe(
        Layer.provide(
          TestSourceControlHost.layerWithRealGit({
            git: { remotes: () => Effect.succeed(Effect.succeed(remotes)) },
          }),
        ),
      );
      const layer = ciLayer.pipe(
        Layer.provide(Layer.mock(GitHubRest.GitHubRest)({})),
        Layer.provide(
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedSome(project) }),
        ),
        Layer.provide(hostLayer),
      );
      yield* Effect.gen(function* () {
        const ci = yield* ProjectCi.ProjectCi;
        yield* ci.read({ projectId });
        yield* ci.read({ projectId, remoteName: "upstream", provider: "gitlab" });
      }).pipe(Effect.provide(layer));
      for (const { env } of environments.filter(({ command }) => command === "glab"))
        assert.deepStrictEqual(env, {
          GITLAB_TOKEN: "",
          GITLAB_ACCESS_TOKEN: "",
          OAUTH_TOKEN: "",
          GH_TOKEN: "ambient-GH_TOKEN",
          GITHUB_TOKEN: "ambient-GITHUB_TOKEN",
          GH_ENTERPRISE_TOKEN: "ambient-GH_ENTERPRISE_TOKEN",
          GITHUB_ENTERPRISE_TOKEN: "ambient-GITHUB_ENTERPRISE_TOKEN",
        });
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }),
);

it.effect.each(["github.com", "code.example.test", "acme.ghe.com"])(
  "reads summaries and selected-run jobs using a saved token without gh on %s",
  (host) => {
    const fixture = harness(`https://${host}/Owner/Repo.git`, (endpoint) =>
      output(
        endpoint.includes("/jobs?")
          ? {
              jobs: [
                {
                  id: 7,
                  name: "test",
                  status: "completed",
                  conclusion: "success",
                  started_at: null,
                  completed_at: null,
                },
              ],
            }
          : endpoint.includes("/42")
            ? rawRun
            : { workflow_runs: [rawRun] },
      ),
    );
    return Effect.gen(function* () {
      const ci = yield* ProjectCi.ProjectCi;
      const summary = yield* ci.read({ projectId, remoteName: "origin", provider: "github" });
      const details = yield* ci.readRun({
        projectId,
        remoteName: "origin",
        provider: "github",
        runId: "42",
      });
      assert.strictEqual(summary.runs[0]?.id, "42");
      assert.strictEqual(details.run.jobs[0]?.name, "test");
      assert.strictEqual(
        details.run.jobs[0]?.url,
        `https://${host}/Owner/Repo/actions/runs/42/job/7`,
      );
      assert.deepStrictEqual(fixture.processes, []);
      for (const request of fixture.requests) {
        assert.strictEqual(request.headers.authorization, "Bearer saved-token");
        assert.isTrue(
          request.url.startsWith(
            host === "github.com"
              ? "https://api.github.com/repos/"
              : host.endsWith(".ghe.com")
                ? `https://api.${host}/repos/`
                : `https://${host}/api/v3/repos/`,
          ),
        );
      }
      assert.notInclude(JSON.stringify({ summary, details }), "saved-token");
    }).pipe(Effect.provide(fixture.layer));
  },
);
it.effect.each(["github", "gitlab"] as const)(
  "keeps old active %s runs beyond ten newer completed runs and deduplicates pages",
  (provider) =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const rawRun = (id: number, active: boolean) =>
        provider === "github"
          ? {
              id,
              name: "CI",
              status: active ? "in_progress" : "completed",
              conclusion: active ? null : "success",
              head_branch: "main",
              head_sha: "abc",
              created_at: "now",
              updated_at: "now",
            }
          : {
              id,
              status: active ? "running" : "success",
              ref: "main",
              sha: "abc",
              created_at: "now",
              updated_at: "now",
            };
      const result = yield* readFixture(
        `git@${provider}.com:Owner/Repo.git`,
        (endpoint) => {
          requests.push(endpoint);
          const query = new URL(endpoint, "https://fixture.test").searchParams;
          const isActive =
            query.get("status") === (provider === "github" ? "in_progress" : "running");
          const runs = endpoint.includes("/jobs?")
            ? []
            : isActive
              ? query.get("page") === "2"
                ? [rawRun(200, true), rawRun(1, true)]
                : Array.from({ length: 100 }, (_, i) => rawRun(200 + i, true))
              : query.has("status")
                ? []
                : Array.from({ length: 20 }, (_, i) => rawRun(1000 + i, false)).slice(0, 10);
          return Effect.succeed(
            TestSourceControlHost.processOutput(
              JSON.stringify(
                provider === "github"
                  ? endpoint.includes("/jobs?")
                    ? { jobs: [] }
                    : { workflow_runs: runs }
                  : runs,
              ),
            ),
          );
        },
        { remoteName: "origin" },
      );
      assert.include(
        result.runs.map((run) => run.id),
        "1",
      );
      assert.strictEqual(result.runs.length, 111);
      assert.strictEqual(
        result.runs.find((run) => run.id === "200")?.status,
        provider === "github" ? "in_progress" : "running",
      );
      assert.isTrue(requests.some((request) => request.includes("page=2")));
      assert.strictEqual(result.activeRunsTruncated, false);
    }),
);

it.effect.each(["github", "gitlab"] as const)(
  "reports the bounded active %s run search as truncated",
  (provider) =>
    Effect.gen(function* () {
      const pages: number[] = [];
      const result = yield* readFixture(
        `https://${provider}.com/Owner/Repo.git`,
        (endpoint) => {
          const query = new URL(endpoint, "https://fixture.test").searchParams;
          const isActive =
            query.get("status") === (provider === "github" ? "in_progress" : "running");
          if (isActive) pages.push(Number(query.get("page")));
          const runs = isActive
            ? Array.from({ length: 100 }, () =>
                provider === "github"
                  ? {
                      id: 1,
                      name: "CI",
                      status: "in_progress",
                      conclusion: null,
                      head_branch: "main",
                      head_sha: "abc",
                      created_at: "now",
                      updated_at: "now",
                    }
                  : {
                      id: 1,
                      status: "running",
                      ref: "main",
                      sha: "abc",
                      created_at: "now",
                      updated_at: "now",
                    },
              )
            : [];
          return Effect.succeed(
            TestSourceControlHost.processOutput(
              JSON.stringify(
                provider === "github"
                  ? endpoint.includes("/jobs?")
                    ? { jobs: [] }
                    : { workflow_runs: runs }
                  : runs,
              ),
            ),
          );
        },
        { remoteName: "origin" },
      );
      assert.strictEqual(result.activeRunsTruncated, true);
      assert.deepStrictEqual(pages, [1, 2, 3, 4, 5]);
      assert.strictEqual(result.runs.length, 1);
    }),
);

it.effect.each(["github", "gitlab"] as const)(
  "lists many active %s runs without fetching any jobs",
  (provider) =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const result = yield* readFixture(
        `https://${provider}.com/Owner/Repo.git`,
        (endpoint) => {
          calls.push(endpoint);
          const query = new URL(endpoint, "https://fixture.test").searchParams;
          const statuses =
            provider === "github"
              ? ["queued", "in_progress", "waiting", "requested", "pending"]
              : ["created", "waiting_for_resource", "preparing", "pending", "running"];
          const offset = statuses.indexOf(query.get("status") ?? "") * 1000;
          const runs = query.has("status")
            ? Array.from({ length: 100 }, (_, index) =>
                provider === "github"
                  ? {
                      id: offset + Number(query.get("page")) * 100 + index,
                      name: "CI",
                      status: "queued",
                      conclusion: null,
                      head_branch: "main",
                      head_sha: "abc",
                      created_at: "now",
                      updated_at: "now",
                    }
                  : {
                      id: offset + Number(query.get("page")) * 100 + index,
                      status: "running",
                      ref: "main",
                      sha: "abc",
                      created_at: "now",
                      updated_at: "now",
                    },
              )
            : Array.from({ length: 10 }, (_, id) =>
                provider === "github"
                  ? {
                      id,
                      name: "CI",
                      status: "completed",
                      conclusion: "success",
                      head_branch: "main",
                      head_sha: "abc",
                      created_at: "now",
                      updated_at: "now",
                    }
                  : {
                      id,
                      status: "success",
                      ref: "main",
                      sha: "abc",
                      created_at: "now",
                      updated_at: "now",
                    },
              );
          return Effect.succeed(
            TestSourceControlHost.processOutput(
              JSON.stringify(provider === "github" ? { workflow_runs: runs, jobs: [] } : runs),
            ),
          );
        },
        { remoteName: "origin" },
      );
      assert.strictEqual(result.runs.length, 2510);
      assert.strictEqual(calls.filter((call) => call.includes("/jobs?")).length, 0);
      assert.strictEqual(calls.length, 26);
    }),
);

it.effect.each(["github", "gitlab"] as const)(
  "retains recent and collected %s runs after an active page failure and continues other statuses",
  (provider) =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const raw = (id: number) =>
        provider === "github"
          ? {
              id,
              name: "CI",
              status: "queued",
              conclusion: null,
              head_branch: "main",
              head_sha: "abc",
              created_at: "now",
              updated_at: "now",
            }
          : {
              id,
              status: "running",
              ref: "main",
              sha: "abc",
              created_at: "now",
              updated_at: "now",
            };
      const result = yield* readFixture(
        `https://${provider}.com/Owner/Repo.git`,
        (endpoint) => {
          calls.push(endpoint);
          const query = new URL(endpoint, "https://fixture.test").searchParams;
          const first = provider === "github" ? "queued" : "created";
          if (query.get("status") === first && query.get("page") === "2")
            return Effect.fail(
              new VcsProcessExitError({
                operation: "api",
                command: "cli",
                cwd: "/repo",
                exitCode: 1,
                detail: "secret",
              }),
            );
          const runs =
            query.get("status") === first
              ? Array.from({ length: 100 }, (_, i) => raw(i + 10))
              : query.has("status")
                ? [raw(200)]
                : [raw(1)];
          return Effect.succeed(
            TestSourceControlHost.processOutput(
              JSON.stringify(
                provider === "github"
                  ? { workflow_runs: runs, jobs: [] }
                  : endpoint.includes("/jobs?")
                    ? []
                    : runs,
              ),
            ),
          );
        },
        { remoteName: "origin" },
      );
      assert.include(
        result.runs.map((run) => run.id),
        "1",
      );
      assert.include(
        result.runs.map((run) => run.id),
        "10",
      );
      assert.include(
        result.runs.map((run) => run.id),
        "200",
      );
      assert.strictEqual(result.activeRunsTruncated, false);
      assert.isTrue(result.activeRunsIncomplete);
      assert.notInclude(JSON.stringify(result), "secret");
    }),
);

it.effect.each(["github", "gitlab"] as const)(
  "loads only the selected %s run and paginates jobs beyond the first hundred",
  (provider) =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const layer = fixtureLayer(`https://${provider}.com/Owner/Repo.git`, (endpoint) => {
        calls.push(endpoint);
        const page = new URL(endpoint, "https://fixture.test").searchParams.get("page");
        const jobs = Array.from({ length: page === "1" ? 100 : 1 }, (_, i) => ({
          id: Number(page) * 100 + i,
          name: `job-${page}-${i}`,
          status: "failed",
          conclusion: "failure",
          started_at: null,
          completed_at: null,
          finished_at: null,
        }));
        const run =
          provider === "github"
            ? {
                html_url:
                  "http://user:secret@github.com:8080/Owner/Repo/actions/runs/42?token=secret",
                id: 42,
                name: "CI",
                status: "completed",
                conclusion: "failure",
                head_branch: "main",
                head_sha: "abc",
                created_at: "now",
                updated_at: "now",
              }
            : {
                web_url:
                  "http://user:secret@gitlab.com:8080/Owner/Repo/-/pipelines/42?token=secret",
                id: 42,
                status: "failed",
                ref: "main",
                sha: "abc",
                created_at: "now",
                updated_at: "now",
              };
        return Effect.succeed(
          TestSourceControlHost.processOutput(
            JSON.stringify(
              endpoint.includes("/jobs?") ? (provider === "github" ? { jobs } : jobs) : run,
            ),
          ),
        );
      });
      const result = yield* Effect.gen(function* () {
        const ci = yield* ProjectCi.ProjectCi;
        return yield* ci.readRun({ projectId, remoteName: "origin", runId: "42" });
      }).pipe(Effect.provide(layer));
      assert.strictEqual(result.run.id, "42");
      assert.strictEqual(result.run.jobs.length, 101);
      assert.strictEqual(result.run.jobs[100]?.status, "failed");
      assert.strictEqual(result.run.jobsTruncated, false);
      assert.strictEqual(
        result.run.jobs[0]?.url,
        provider === "github"
          ? "http://github.com:8080/Owner/Repo/actions/runs/42/job/100"
          : "http://gitlab.com:8080/Owner/Repo/-/jobs/100",
      );
      assert.notInclude(JSON.stringify(result), "secret");
      assert.strictEqual(calls.length, 3);
      assert.isTrue(calls.every((endpoint) => endpoint.includes("/42")));
      assert.isTrue(calls[2]?.endsWith("page=2"));
    }),
);

it.effect.each(["github", "gitlab"] as const)(
  "exposes bounded or interrupted %s job coverage without dropping collected jobs",
  (provider) =>
    Effect.gen(function* () {
      for (const failurePage of [null, 2]) {
        const calls: string[] = [];
        const layer = fixtureLayer(`https://${provider}.com/Owner/Repo.git`, (endpoint) => {
          calls.push(endpoint);
          const page = new URL(endpoint, "https://fixture.test").searchParams.get("page");
          if (page !== null && Number(page) === failurePage)
            return Effect.fail(
              new VcsProcessExitError({
                operation: "api",
                command: "cli",
                cwd: "/repo",
                exitCode: 1,
                detail: "secret",
              }),
            );
          const jobs = Array.from({ length: 100 }, (_, i) => ({
            id: Number(page) * 100 + i,
            name: "test",
            status: "failed",
            conclusion: "failure",
            started_at: null,
            completed_at: null,
            finished_at: null,
          }));
          return Effect.succeed(
            TestSourceControlHost.processOutput(
              JSON.stringify(
                page !== null
                  ? provider === "github"
                    ? { jobs }
                    : jobs
                  : provider === "github"
                    ? {
                        id: 42,
                        name: "CI",
                        status: "completed",
                        conclusion: "failure",
                        head_branch: "main",
                        head_sha: "abc",
                        created_at: "now",
                        updated_at: "now",
                      }
                    : {
                        id: 42,
                        status: "failed",
                        ref: "main",
                        sha: "abc",
                        created_at: "now",
                        updated_at: "now",
                      },
              ),
            ),
          );
        });
        const result = yield* Effect.gen(function* () {
          const ci = yield* ProjectCi.ProjectCi;
          return yield* ci.readRun({ projectId, remoteName: "origin", runId: "42" });
        }).pipe(Effect.provide(layer));
        assert.strictEqual(result.run.jobs.length, failurePage === null ? 500 : 100);
        assert.strictEqual(result.run.jobsTruncated, failurePage === null);
        assert.strictEqual(
          result.run.jobsError,
          failurePage === null ? undefined : "request_failed",
        );
        assert.strictEqual(calls.length, failurePage === null ? 6 : 3);
        assert.notInclude(JSON.stringify(result), "secret");
      }
    }),
);

it.effect.each([401, 403, 404, 500])("maps HTTP %s to a bounded CI error", (status) => {
  const fixture = harness(
    "https://github.com/Owner/Repo.git",
    () => output({ message: "secret" }),
    { status },
  );
  return Effect.gen(function* () {
    const ci = yield* ProjectCi.ProjectCi;
    const error = yield* Effect.flip(ci.read({ projectId, remoteName: "origin" }));
    assert.strictEqual(error.reason, status === 401 ? "authentication" : "request_failed");
    assert.notInclude(JSON.stringify(error), "secret");
    assert.deepStrictEqual(fixture.processes, []);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("keeps selected-run details when jobs refuse authentication", () => {
  const fixture = harness("https://github.com/Owner/Repo.git", () => output({}), {
    http: (request) =>
      Effect.succeed(
        request.url.includes("/jobs?")
          ? new Response("secret", { status: 401 })
          : new Response(JSON.stringify(rawRun)),
      ),
  });
  return Effect.gen(function* () {
    const ci = yield* ProjectCi.ProjectCi;
    const result = yield* ci.readRun({ projectId, remoteName: "origin", runId: "42" });
    assert.strictEqual(result.run.id, "42");
    assert.strictEqual(result.run.jobsError, "authentication");
    assert.deepStrictEqual(result.run.jobs, []);
    assert.notInclude(JSON.stringify(result), "secret");
  }).pipe(Effect.provide(fixture.layer));
});

it.effect(
  "rejects a response larger than one MiB even when the collected prefix is valid JSON",
  () => {
    const fixture = harness("https://github.com/Owner/Repo.git", () => output({}), {
      http: () => Effect.succeed(new Response('{"workflow_runs":[]}' + " ".repeat(1024 * 1024))),
    });
    return Effect.gen(function* () {
      const ci = yield* ProjectCi.ProjectCi;
      const error = yield* Effect.flip(ci.read({ projectId, remoteName: "origin" }));
      assert.strictEqual(error.reason, "invalid_response");
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect("interrupts a stalled HTTP body at the fifteen-second deadline", () =>
  Effect.gen(function* () {
    const reading = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const fixture = harness("https://github.com/Owner/Repo.git", () => output({}), {
      http: () =>
        Effect.succeed(
          new Response(
            new ReadableStream<Uint8Array>({
              pull: () => {
                Deferred.doneUnsafe(reading, Effect.void);
              },
              cancel: () => {
                Deferred.doneUnsafe(cancelled, Effect.void);
              },
            }),
          ),
        ),
    });
    yield* Effect.gen(function* () {
      const ci = yield* ProjectCi.ProjectCi;
      const request = yield* ci
        .read({ projectId, remoteName: "origin" })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(reading);
      yield* TestClock.adjust("15 seconds");
      const error = yield* Fiber.join(request);
      assert.strictEqual(error.reason, "request_failed");
      yield* Deferred.await(cancelled);
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect("keeps GitLab requests host-qualified with sanitized tokens and process bounds", () => {
  const fixture = harness("http://code.example.test:8080/Group/Nested/Repo.git", () => output([]));
  return Effect.gen(function* () {
    const ci = yield* ProjectCi.ProjectCi;
    yield* ci.read({ projectId, remoteName: "origin", provider: "gitlab" });
    assert.deepStrictEqual(fixture.requests, []);
    assert.strictEqual(fixture.processes.length, 6);
    for (const input of fixture.processes) {
      assert.strictEqual(input.command, "glab");
      assert.deepStrictEqual(input.args.slice(0, 3), [
        "api",
        "--hostname",
        "code.example.test:8080",
      ]);
      assert.include(input.args[3], "projects/Group%2FNested%2FRepo/pipelines?");
      assert.deepStrictEqual(input.env, {
        GITLAB_TOKEN: "",
        GITLAB_ACCESS_TOKEN: "",
        OAUTH_TOKEN: "",
      });
      assert.strictEqual(input.timeoutMs, 15_000);
      assert.strictEqual(input.maxOutputBytes, 1024 * 1024);
    }
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("shares REST quota pauses with other GitHub readers", () => {
  const fixture = harness("https://github.com/Owner/Repo.git", () => output({}), {
    http: () =>
      Effect.succeed(
        new Response('{"message":"API rate limit exceeded"}', {
          status: 403,
          headers: { "retry-after": "60" },
        }),
      ),
  });
  return Effect.gen(function* () {
    const rest = yield* GitHubRest.GitHubRest;
    const ci = yield* ProjectCi.ProjectCi;
    yield* Effect.flip(rest.rest({ host: "github.com", operation: "otherReader", path: "user" }));
    const error = yield* Effect.flip(ci.read({ projectId, remoteName: "origin" }));
    assert.strictEqual(error.reason, "request_failed");
    assert.strictEqual(fixture.requests.length, 1);
  }).pipe(Effect.provide(fixture.layer));
});

const readDiscoveryFixture = (
  url: string,
  run: SourceControlHost.SourceControlHost["Service"]["process"]["run"],
  input: { remoteName?: string; provider?: "github" | "gitlab" } = {},
) =>
  Effect.gen(function* () {
    const ci = yield* ProjectCi.ProjectCi;
    return yield* ci.read({ projectId, ...input });
  }).pipe(
    Effect.provide(
      ciLayer.pipe(
        Layer.provide(Layer.mock(GitHubRest.GitHubRest)({})),
        Layer.provide(
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedSome(project) }),
        ),
        Layer.provide(
          TestSourceControlHost.layer({
            git: {
              remotes: () =>
                Effect.succeed(Effect.succeed({ ...remotes, remotes: [remote("origin", url)] })),
            },
            process: { run },
          }),
        ),
      ),
    ),
  );

it.effect.each([
  "github.com:Owner/Repo.git",
  "GITHUB.COM:Owner/Repo.GIT",
  "git@GITHUB.COM:Owner/Repo.git",
  "ssh://git@GITHUB.COM:2222/Owner/Repo.git",
  "https://GITHUB.COM/Owner/Repo.git",
])("discovers GitHub remote %s", (url) =>
  Effect.gen(function* () {
    const result = yield* readDiscoveryFixture(url, () => {
      throw new Error("Unexpected provider request");
    });
    assert.deepStrictEqual(result.remotes, [
      { name: "origin", host: "github.com", repository: "Owner/Repo", provider: "github" },
    ]);
  }),
);

it.effect(
  "discovers a configured self-hosted GitLab without an explicit provider or ambient tokens",
  () =>
    Effect.gen(function* () {
      const calls: SourceControlHost.SourceControlProcessInput[] = [];
      const result = yield* readDiscoveryFixture(
        "ssh://git@CODE.EXAMPLE.TEST:2222/Group/Nested/Repo.git",
        (input) => {
          calls.push(input);
          return Effect.succeed(
            TestSourceControlHost.processOutput(
              input.args[0] === "auth"
                ? "code.example.test\n  ✓ Logged in to code.example.test as fixture-user\n"
                : "[]",
            ),
          );
        },
        { remoteName: "origin" },
      );
      assert.strictEqual(result.selectedRemote?.provider, "gitlab");
      assert.deepStrictEqual(calls[0]?.args, ["auth", "status", "--hostname", "code.example.test"]);
      for (const call of calls) {
        assert.strictEqual(call.command, "glab");
        assert.strictEqual(call.env?.GITLAB_TOKEN, "");
        assert.strictEqual(call.env?.GITLAB_ACCESS_TOKEN, "");
        assert.strictEqual(call.env?.OAUTH_TOKEN, "");
      }
    }),
);

it.effect("does not claim an unknown remote based on a different GitLab login", () =>
  Effect.gen(function* () {
    const result = yield* readDiscoveryFixture("code.example.test:Group/Repo.git", () =>
      Effect.succeed(
        TestSourceControlHost.processOutput(
          "other.example.test\n  ✓ Logged in to other.example.test as fixture-user\n",
        ),
      ),
    );
    assert.isNull(result.remotes[0]?.provider);
  }),
);
