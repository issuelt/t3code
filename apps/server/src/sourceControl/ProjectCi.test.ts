import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as Redacted from "effect/Redacted";
import { Project, ProjectId, TrimmedNonEmptyString, VcsProcessExitError } from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectCi from "./ProjectCi.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as GitLabDriver from "@t3tools/source-control-gitlab/server/driver";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as BuiltInDrivers from "./builtInDrivers.ts";

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
      Layer.provide(
        Layer.mock(GitHubCredentials.GitHubCredentials)({
          get: () =>
            Effect.succeed({
              host: "github.com",
              token: Redacted.make("token"),
              source: "settings",
              fingerprint: "test",
            }),
        }),
      ),
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

it.effect("returns a bounded error when the host CLI fails", () =>
  Effect.gen(function* () {
    const layer = ciLayer.pipe(
      Layer.provide(
        Layer.mock(GitHubCredentials.GitHubCredentials)({
          get: () =>
            Effect.succeed({
              host: "github.com",
              token: Redacted.make("token"),
              source: "settings",
              fingerprint: "test",
            }),
        }),
      ),
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
                  command: "gh",
                  cwd: "/repo",
                  exitCode: 1,
                  detail: "secret",
                }),
              ),
          },
        }),
      ),
    );
    const error = yield* Effect.gen(function* () {
      const ci = yield* ProjectCi.ProjectCi;
      return yield* ci.read({ projectId, remoteName: "origin" });
    }).pipe(Effect.provide(layer), Effect.flip);
    assert.strictEqual(error.reason, "request_failed");
    assert.notInclude(error.message, "secret");
  }),
);

it.effect("reads GitHub summaries with the server credential", () =>
  Effect.gen(function* () {
    const calls: Array<{
      command: string;
      args: ReadonlyArray<string>;
      env: NodeJS.ProcessEnv | undefined;
    }> = [];
    const layer = ciLayer.pipe(
      Layer.provide(
        Layer.mock(GitHubCredentials.GitHubCredentials)({
          get: () =>
            Effect.succeed({
              host: "github.com",
              token: Redacted.make("token"),
              source: "settings",
              fingerprint: "test",
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedSome(project) }),
      ),
      Layer.provide(
        TestSourceControlHost.layer({
          git: { remotes: () => Effect.succeed(Effect.succeed(remotes)) },
          process: {
            run: (input) => {
              calls.push({ command: input.command, args: input.args, env: input.env });
              return Effect.succeed(
                TestSourceControlHost.processOutput(
                  input.args[3]?.includes("/jobs?")
                    ? JSON.stringify({
                        jobs: [
                          {
                            id: 12,
                            name: "build",
                            status: "completed",
                            conclusion: "failure",
                            started_at: null,
                            completed_at: null,
                          },
                        ],
                      })
                    : JSON.stringify({
                        workflow_runs: [
                          {
                            id: 11,
                            name: "CI",
                            status: "completed",
                            conclusion: "failure",
                            head_branch: "main",
                            head_sha: "abc",
                            created_at: "now",
                            updated_at: "now",
                          },
                        ],
                      }),
                ),
              );
            },
          },
        }),
      ),
    );
    const result = yield* Effect.gen(function* () {
      const ci = yield* ProjectCi.ProjectCi;
      return yield* ci.read({ projectId, remoteName: "origin" });
    }).pipe(Effect.provide(layer));
    assert.strictEqual(result.runs[0]?.url, "https://github.com/Owner/Repo/actions/runs/11");
    assert.strictEqual(result.runs[0]?.conclusion, "failure");
    assert.strictEqual(calls[0]?.env?.GH_TOKEN, "token");
    assert.notInclude(JSON.stringify(result), "token");
  }),
);

it.effect("reports authentication failures without returning CLI output", () =>
  Effect.gen(function* () {
    const layer = ciLayer.pipe(
      Layer.provide(Layer.mock(GitHubCredentials.GitHubCredentials)({})),
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
      Layer.provide(Layer.mock(GitHubCredentials.GitHubCredentials)({})),
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
      Layer.provide(Layer.mock(GitHubCredentials.GitHubCredentials)({})),
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
      Layer.provide(Layer.mock(GitHubCredentials.GitHubCredentials)({})),
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

it.live("isolates ambient CLI tokens in the spawned process", () =>
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
        Layer.provide(
          Layer.mock(GitHubCredentials.GitHubCredentials)({
            get: (host) =>
              Effect.succeed({
                host,
                token: Redacted.make("host-token"),
                source: "settings",
                fingerprint: "test",
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedSome(project) }),
        ),
        Layer.provide(hostLayer),
      );
      yield* Effect.gen(function* () {
        const ci = yield* ProjectCi.ProjectCi;
        yield* ci.read({ projectId });
        yield* ci.read({ projectId, remoteName: "upstream", provider: "gitlab" });
        yield* ci.read({ projectId, remoteName: "upstream", provider: "github" });
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
      for (const { env } of environments.filter(({ command }) => command === "gh"))
        assert.deepStrictEqual(env, {
          GITLAB_TOKEN: "ambient-GITLAB_TOKEN",
          GITLAB_ACCESS_TOKEN: "ambient-GITLAB_ACCESS_TOKEN",
          OAUTH_TOKEN: "ambient-OAUTH_TOKEN",
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          GH_ENTERPRISE_TOKEN: "host-token",
          GITHUB_ENTERPRISE_TOKEN: "",
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

const fixtureLayer = (
  url: string,
  run: SourceControlHost.SourceControlHost["Service"]["process"]["run"],
) =>
  ciLayer.pipe(
    Layer.provide(
      Layer.mock(GitHubCredentials.GitHubCredentials)({
        get: (host) =>
          Effect.succeed({
            host,
            token: Redacted.make("host-token"),
            source: "settings",
            fingerprint: "test",
          }),
      }),
    ),
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
  );
const readFixture = (
  url: string,
  run: SourceControlHost.SourceControlHost["Service"]["process"]["run"],
  input: { remoteName?: string; provider?: "github" | "gitlab" } = {},
) =>
  Effect.gen(function* () {
    const ci = yield* ProjectCi.ProjectCi;
    return yield* ci.read({ projectId, ...input });
  }).pipe(Effect.provide(fixtureLayer(url, run)));

it.effect.each([
  "github.com:Owner/Repo.git",
  "GITHUB.COM:Owner/Repo.GIT",
  "git@GITHUB.COM:Owner/Repo.git",
  "ssh://git@GITHUB.COM:2222/Owner/Repo.git",
  "https://GITHUB.COM/Owner/Repo.git",
])("discovers GitHub remote %s", (url) =>
  Effect.gen(function* () {
    const result = yield* readFixture(url, () => {
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
      const result = yield* readFixture(
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
    const result = yield* readFixture("code.example.test:Group/Repo.git", () =>
      Effect.succeed(
        TestSourceControlHost.processOutput(
          "other.example.test\n  ✓ Logged in to other.example.test as fixture-user\n",
        ),
      ),
    );
    assert.isNull(result.remotes[0]?.provider);
  }),
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
        (input) => {
          const endpoint = input.args[3] ?? "";
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
        (input) => {
          const endpoint = input.args[3] ?? "";
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
        (input) => {
          const endpoint = input.args[3] ?? "";
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
        (input) => {
          const endpoint = input.args[3] ?? "";
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
      const layer = fixtureLayer(`https://${provider}.com/Owner/Repo.git`, (input) => {
        const endpoint = input.args[3] ?? "";
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
        const layer = fixtureLayer(`https://${provider}.com/Owner/Repo.git`, (input) => {
          const endpoint = input.args[3] ?? "";
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
