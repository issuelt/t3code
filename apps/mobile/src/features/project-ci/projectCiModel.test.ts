import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { EnvironmentId, ProjectId, type ProjectCiRunResult } from "@t3tools/contracts";
import { createCiRunDetailsView } from "./projectCiRunState";
import { describe, expect, it } from "vite-plus/test";
import {
  ciRunActive,
  ciRunFailed,
  preferredCiRemote,
  visibleCiRuns,
  type CiRun,
} from "./projectCiModel";

const run = (id: string, status: string, overrides: Partial<CiRun> = {}): CiRun => ({
  id,
  name: "Build",
  status,
  conclusion: null,
  url: `https://github.com/a/b/actions/runs/${id}`,
  branch: "main",
  sha: "abc123",
  createdAt: "2026-10-28T10:00:00Z",
  updatedAt: "2026-10-28T10:00:00Z",
  ...overrides,
});

describe("mobile CI runs", () => {
  it("selects upstream, origin, then alphabetically without changing the registered remotes", () => {
    const remotes = ["zeta", "origin", "alpha", "upstream"].map((name) => ({
      name,
      host: "github.com",
      repository: "a/b",
      provider: "github" as const,
    }));
    expect(preferredCiRemote(remotes)?.name).toBe("upstream");
    expect(preferredCiRemote(remotes.filter((remote) => remote.name !== "upstream"))?.name).toBe(
      "origin",
    );
    expect(preferredCiRemote([remotes[0]!, remotes[2]!])?.name).toBe("alpha");
    expect(remotes.map((remote) => remote.name)).toEqual(["zeta", "origin", "alpha", "upstream"]);
    expect(preferredCiRemote([])).toBeNull();
  });

  it("keeps GitLab created and resource-waiting pipelines ahead of failures and successful runs", () => {
    const runs = [
      run("success", "completed", { conclusion: "success" }),
      run("failed", "failed"),
      run("created", "created"),
      run("waiting", "waiting_for_resource"),
      run("running", "in_progress"),
    ];
    expect(visibleCiRuns(runs, "all", "").map((item) => item.id)).toEqual([
      "created",
      "running",
      "waiting",
      "failed",
      "success",
    ]);
    expect(visibleCiRuns(runs, "active", "").map((item) => item.id)).toEqual([
      "created",
      "running",
      "waiting",
    ]);
    expect(visibleCiRuns(runs, "failed", "").map((item) => item.id)).toEqual(["failed"]);
    expect(ciRunActive(run("manual", "manual"))).toBe(false);
  });

  it("filters names, branches and commits case-insensitively and recognizes job failures", () => {
    const runs = [
      run("1", "completed", { name: "Unit tests", conclusion: "timed_out", branch: "feature/CI" }),
      run("2", "running", { branch: null, sha: "deadbeef" }),
    ];
    expect(visibleCiRuns(runs, "failed", "  UNIT ").map((item) => item.id)).toEqual(["1"]);
    expect(visibleCiRuns(runs, "all", "FEATURE/ci").map((item) => item.id)).toEqual(["1"]);
    expect(visibleCiRuns(runs, "active", "DEAD").map((item) => item.id)).toEqual(["2"]);
    expect(ciRunFailed({ status: "completed", conclusion: "failure" })).toBe(true);
    expect(ciRunFailed({ status: "failed", conclusion: null })).toBe(true);
    expect(ciRunFailed({ status: "completed", conclusion: "cancelled" })).toBe(false);
  });

  it("sorts each state by the latest update without mutating the response", () => {
    const runs = [
      run("old", "running"),
      run("new", "running", { updatedAt: "2026-10-28T11:00:00Z" }),
    ];
    expect(visibleCiRuns(runs, "all", "").map((item) => item.id)).toEqual(["new", "old"]);
    expect(runs.map((item) => item.id)).toEqual(["old", "new"]);
  });
});

it("retains the latest completed run by ID after it leaves recent results and a refresh fails", () => {
  const registry = AtomRegistry.make();
  try {
    const initial = run("42", "running");
    const completed: ProjectCiRunResult = {
      fetchedAt: "2026-10-28T11:00:00Z",
      run: {
        ...initial,
        status: "completed",
        conclusion: "success",
        jobs: [],
        jobsTruncated: false,
      },
    };
    const result = Atom.make<AsyncResult.AsyncResult<ProjectCiRunResult, Error>>(
      AsyncResult.initial(),
    );
    const requests: string[] = [];
    const details = createCiRunDetailsView((target) => {
      requests.push(target.input.runId);
      return result;
    });
    const view = details({
      target: {
        environmentId: EnvironmentId.make("local"),
        input: { projectId: ProjectId.make("p"), remoteName: "origin", runId: "42" },
      },
      fallback: initial,
    });
    const unmount = registry.mount(view);
    expect(registry.get(view).run.status).toBe("running");
    registry.set(result, AsyncResult.success(completed));
    expect(registry.get(view).run.status).toBe("completed");
    const job = {
      name: "build",
      status: "completed",
      conclusion: "success",
      url: "https://github.com/a/b/job/1",
      startedAt: null,
      completedAt: null,
    };
    registry.set(
      result,
      AsyncResult.success({ ...completed, run: { ...completed.run, jobs: [job] } }),
    );
    expect(registry.get(view).value?.run.jobs).toEqual([job]);
    registry.set(
      result,
      AsyncResult.success({ ...completed, run: { ...completed.run, jobsError: "request_failed" } }),
    );
    expect(registry.get(view).value?.run.jobs).toEqual([job]);
    expect(registry.get(view).value?.run.jobsError).toBe("request_failed");
    registry.set(
      result,
      AsyncResult.failure(Cause.fail(new Error("Provider unavailable")), {
        previousSuccess: Option.some(AsyncResult.success(completed)),
      }),
    );
    expect(registry.get(view).run.status).toBe("completed");
    expect(registry.get(view).error).toContain("Provider unavailable");
    expect(requests.every((id) => id === "42")).toBe(true);
    unmount();
  } finally {
    registry.dispose();
  }
});
