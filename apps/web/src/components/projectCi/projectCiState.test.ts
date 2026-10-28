import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  type ProjectCiRunResult,
  type ProjectCiResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  createProjectCiRows,
  createProjectCiRunView,
  limitProjectCiReads,
  type Target,
} from "./projectCiState";

function setup() {
  const registry = AtomRegistry.make();
  const queries = Atom.family((_key: string) =>
    Atom.make<AsyncResult.AsyncResult<ProjectCiResult, Error>>(AsyncResult.initial()),
  );
  const query = (target: Target) => queries(JSON.stringify(target));
  const rows = createProjectCiRows(query);
  const target = {
    environmentId: EnvironmentId.make("local"),
    input: { projectId: ProjectId.make("p") },
  };
  const remotes: ProjectCiResult["remotes"] = ["zebra", "origin", "upstream"].map((name) => ({
    name,
    repository: `owner/${name}`,
    host: "github.com",
    provider: "github",
  }));
  const discovery: ProjectCiResult = {
    remotes,
    selectedRemote: null,
    fetchedAt: "2026-10-28T10:00:00Z",
    runs: [],
  };
  return { registry, query, rows, target, discovery, [Symbol.dispose]: () => registry.dispose() };
}

describe("project CI discovery and pipelines", () => {
  it.each([
    { names: ["origin", "upstream", "alpha"], expected: "upstream" },
    { names: ["zebra", "origin", "alpha"], expected: "origin" },
    { names: ["zebra", "beta", "alpha"], expected: "alpha" },
  ])("selects $expected from discovered remotes", ({ names, expected }) => {
    using s = setup();
    s.registry.set(
      s.query(s.target),
      AsyncResult.success({
        ...s.discovery,
        remotes: names.map((name) => ({
          name,
          repository: `owner/${name}`,
          host: "github.com",
          provider: "github",
        })),
      }),
    );
    const atom = s.rows([s.target]);
    expect(s.rows([{ ...s.target, input: { ...s.target.input } }])).toBe(atom);
    expect(s.registry.get(atom)[0]?.runTarget?.input.remoteName).toBe(expected);
  });

  it("discovers then reads upstream automatically without presenting discovery as fetched pipelines", () => {
    using s = setup();
    const atom = s.rows([s.target]);
    const unmount = s.registry.mount(atom);
    s.registry.set(s.query(s.target), AsyncResult.success(s.discovery));
    const [row] = s.registry.get(atom);
    expect(row?.selectedRemote?.name).toBe("upstream");
    expect(row?.data).toBeNull();
    expect(row?.pending).toBe(true);
    const upstream = s.query({ ...s.target, input: { ...s.target.input, remoteName: "upstream" } });
    const pipelines = { ...s.discovery, selectedRemote: s.discovery.remotes[2] ?? null };
    s.registry.set(upstream, AsyncResult.success(pipelines));
    expect(s.registry.get(atom)[0]?.data).toEqual(pipelines);
    unmount();
  });

  it("keeps remote choices after a provider error and permits switching to origin", () => {
    using s = setup();
    s.registry.set(s.query(s.target), AsyncResult.success(s.discovery));
    s.registry.set(
      s.query({ ...s.target, input: { ...s.target.input, remoteName: "upstream" } }),
      AsyncResult.failure(Cause.fail(new Error("Authentication failed"))),
    );
    const failed = s.registry.get(s.rows([s.target]))[0];
    expect(failed?.error).toContain("Authentication failed");
    expect(failed?.discovery?.remotes).toHaveLength(3);
    const selected = { ...s.target, input: { ...s.target.input, remoteName: "origin" } };
    const pipelines = { ...s.discovery, selectedRemote: s.discovery.remotes[1] ?? null };
    s.registry.set(s.query(selected), AsyncResult.success(pipelines));
    const switched = s.registry.get(s.rows([selected]))[0];
    expect(switched?.error).toBeNull();
    expect(switched?.data).toEqual(pipelines);
  });

  it("retains the last pipeline fetch and timestamp on refresh failure independently per project", () => {
    using s = setup();
    s.registry.set(s.query(s.target), AsyncResult.success(s.discovery));
    const selected = { ...s.target, input: { ...s.target.input, remoteName: "upstream" } };
    const pipelines = {
      ...s.discovery,
      selectedRemote: s.discovery.remotes[2] ?? null,
      fetchedAt: "2026-10-28T10:01:00Z",
    };
    const success = AsyncResult.success(pipelines);
    s.registry.set(
      s.query(selected),
      AsyncResult.failure(Cause.fail(new Error("Provider unavailable")), {
        previousSuccess: Option.some(success),
      }),
    );
    const other = { ...s.target, input: { projectId: ProjectId.make("other") } };
    const [failed, pending] = s.registry.get(s.rows([s.target, other]));
    expect(failed?.data?.fetchedAt).toBe(pipelines.fetchedAt);
    expect(failed?.error).toContain("Provider unavailable");
    expect(pending?.error).toBeNull();
    expect(pending?.pending).toBe(true);
  });
});

it.effect("bounds initial and refresh reads to four concurrent requests", () =>
  Effect.gen(function* () {
    for (const phase of ["initial", "refresh"]) {
      const started = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      let active = 0;
      let maximum = 0;
      let completed = 0;
      const work = limitProjectCiReads(
        Effect.gen(function* () {
          active++;
          maximum = Math.max(maximum, active);
          if (active === 4) yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          active--;
          completed++;
        }),
      );
      const completion = yield* Effect.forkChild(
        Effect.all(
          Array.from({ length: 12 }, () => work),
          { concurrency: "unbounded" },
        ),
      );
      yield* Deferred.await(started);
      expect(active, phase).toBe(4);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(completion);
      expect(maximum, phase).toBe(4);
      expect(completed, phase).toBe(12);
    }
  }),
);

it.effect(
  "refreshes pipeline queries, retains runs on failure, and replaces them on recovery",
  () =>
    Effect.gen(function* () {
      using s = setup();
      const remote = s.discovery.remotes[2] ?? null;
      const first = {
        ...s.discovery,
        selectedRemote: remote,
        runs: [
          {
            id: "run-1",
            name: "Build",
            status: "running",
            conclusion: null,
            url: "https://github.com/owner/repo/actions/runs/1",
            branch: "main",
            sha: "abc",
            createdAt: "2026-10-28T10:00:00Z",
            updatedAt: "2026-10-28T10:00:00Z",
          },
        ],
      };
      const latest = { ...first, fetchedAt: "2026-10-28T10:02:00Z", runs: [] };
      const refreshFailure = Deferred.makeUnsafe<ProjectCiResult, Error>();
      let attempt = 0;
      const pipelines = Atom.make(
        Effect.suspend(() => {
          attempt++;
          return attempt === 1
            ? Effect.succeed(first)
            : attempt === 2
              ? Deferred.await(refreshFailure)
              : Effect.succeed(latest);
        }),
      ).pipe(Atom.swr({ staleTime: 60_000 }));
      const query = (target: Target) => (target.input.remoteName ? pipelines : s.query(target));
      s.registry.set(s.query(s.target), AsyncResult.success(s.discovery));
      const rows = createProjectCiRows(query)([s.target]);
      const unmount = s.registry.mount(rows);
      yield* AtomRegistry.getResult(s.registry, pipelines, { suspendOnWaiting: true });
      expect(s.registry.get(rows)[0]?.data?.runs).toHaveLength(1);
      s.registry.refresh(pipelines);
      expect(s.registry.get(rows)[0]?.data).toEqual(first);
      expect(s.registry.get(rows)[0]?.pending).toBe(true);
      yield* Deferred.fail(refreshFailure, new Error("Refresh failed"));
      yield* AtomRegistry.getResult(s.registry, pipelines, { suspendOnWaiting: true }).pipe(
        Effect.exit,
      );
      expect(s.registry.get(rows)[0]?.data).toEqual(first);
      expect(s.registry.get(rows)[0]?.error).toContain("Refresh failed");
      s.registry.refresh(pipelines);
      yield* AtomRegistry.getResult(s.registry, pipelines, { suspendOnWaiting: true });
      expect(s.registry.get(rows)[0]?.data).toEqual(latest);
      expect(s.registry.get(rows)[0]?.error).toBeNull();
      unmount();
    }),
);

it("fetches details only for an expanded stable run ID and retains them on refresh failure", () => {
  using s = setup();
  const requested: string[] = [];
  const result = Atom.make<AsyncResult.AsyncResult<ProjectCiRunResult, Error>>(
    AsyncResult.initial(),
  );
  const details = createProjectCiRunView((target) => {
    requested.push(target.input.runId);
    return result;
  });
  expect(s.registry.get(details(null)).data).toBeNull();
  expect(requested).toEqual([]);
  const target = { ...s.target, input: { ...s.target.input, remoteName: "upstream", runId: "42" } };
  const view = details(target);
  const unmount = s.registry.mount(view);
  const completed: ProjectCiRunResult = {
    fetchedAt: "2026-10-28T11:00:00Z",
    run: {
      id: "42",
      name: "CI",
      status: "completed",
      conclusion: "failure",
      branch: "main",
      sha: "abc",
      url: "https://github.com/a/b/actions/runs/42",
      createdAt: "now",
      updatedAt: "now",
      jobs: [],
      jobsTruncated: false,
    },
  };
  const job = {
    name: "test",
    status: "completed",
    conclusion: "failure",
    url: "https://github.com/a/b/job/1",
    startedAt: null,
    completedAt: null,
  };
  const withJobs = { ...completed, run: { ...completed.run, jobs: [job] } };
  s.registry.set(result, AsyncResult.success(withJobs));
  expect(s.registry.get(view).data).toEqual(withJobs);
  s.registry.set(
    result,
    AsyncResult.success({
      ...completed,
      run: { ...completed.run, jobs: [], jobsError: "request_failed" },
    }),
  );
  expect(s.registry.get(view).data?.run.jobs).toEqual([job]);
  expect(s.registry.get(view).data?.run.jobsError).toBe("request_failed");
  s.registry.set(
    result,
    AsyncResult.failure(Cause.fail(new Error("Unavailable")), {
      previousSuccess: Option.some(AsyncResult.success(completed)),
    }),
  );
  expect(s.registry.get(view).data?.run.status).toBe("completed");
  expect(s.registry.get(view).error).toContain("Unavailable");
  expect(requested.every((id) => id === "42")).toBe(true);
  unmount();
});
