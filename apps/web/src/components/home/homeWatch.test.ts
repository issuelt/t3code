import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, type HomeSettings, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  diffWatchedThreads,
  dropSupersededCompletions,
  homeWatchKey,
  type WatchedThreadState,
} from "./homeWatch";

const studio = EnvironmentId.make("studio");

const thread = (
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell =>
  ({
    environmentId: studio,
    id: ThreadId.make(id),
    title: `Thread ${id}`,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: null },
    latestRun: { runId: "run-1", status: "running", completedAt: null },
    runtime: { status: "running", lastErrorClass: null },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    archivedAt: null,
    settledOverride: null,
    ...overrides,
  }) as unknown as EnvironmentThreadShell;

const watching = (...ids: Array<string>): HomeSettings => ({
  threadId: ThreadId.make("home:current"),
  watchAll: false,
  watches: ids.map((id) => ({
    environmentId: studio,
    threadId: ThreadId.make(id),
    reason: "launched",
  })),
});

const run = (
  previous: ReadonlyMap<string, WatchedThreadState>,
  shells: Array<EnvironmentThreadShell>,
  home: HomeSettings,
  options: { readonly knownWatchKeys?: ReadonlySet<string>; readonly live?: boolean } = {},
) =>
  diffWatchedThreads({
    previous,
    shells,
    home,
    knownWatchKeys:
      options.knownWatchKeys ??
      new Set(home.watches.map((watch) => homeWatchKey(watch.environmentId, watch.threadId))),
    liveEnvironmentIds: new Set(options.live === false ? [] : [studio]),
    labelFor: () => "Studio",
  });

describe("diffWatchedThreads", () => {
  it("sets a baseline first, then reports a question and a completion", () => {
    const home = watching("a");
    const first = run(new Map(), [thread("a")], home);
    expect(first.events).toEqual([]);

    const asked = run(first.next, [thread("a", { hasPendingUserInput: true })], home);
    expect(asked.events).toMatchObject([
      { threadId: "a", kind: "question", environmentLabel: "Studio" },
    ]);

    const done = run(
      asked.next,
      [
        thread("a", {
          latestRun: {
            runId: "run-1",
            status: "completed",
            completedAt: "2026-10-03T10:00:00.000Z",
          },
          runtime: null,
        } as Partial<EnvironmentThreadShell>),
      ],
      home,
    );
    expect(done.events).toMatchObject([{ threadId: "a", kind: "completed", runId: "run-1" }]);
  });

  it("ignores unwatched threads and every Home thread, even when watching all", () => {
    const shells = [thread("a"), thread("home:old")];
    const first = run(new Map(), shells, watching());
    expect(first.next.size).toBe(0);

    const all = { ...watching(), watchAll: true };
    const baseline = run(new Map(), shells, all);
    const asked = run(
      baseline.next,
      shells.map((shell) => ({ ...shell, hasPendingApprovals: true })),
      all,
    );
    expect(asked.events).toMatchObject([{ threadId: "a", kind: "approval" }]);
  });

  it("ends a watch once when the thread is settled", () => {
    const home = watching("a");
    const first = run(new Map(), [thread("a")], home);
    const settled = run(first.next, [thread("a", { settledOverride: "settled" })], home);
    expect(settled.events).toMatchObject([{ threadId: "a", kind: "ended" }]);
    expect(run(settled.next, [thread("a", { settledOverride: "settled" })], home).events).toEqual(
      [],
    );
  });

  it("reports the first state of a thread Home launched after it started", () => {
    const asking = [thread("a", { hasPendingApprovals: true })];
    const launched = run(new Map(), asking, watching("a"), { knownWatchKeys: new Set() });
    expect(launched.events).toMatchObject([{ threadId: "a", kind: "approval" }]);
    expect(run(new Map(), asking, watching("a")).events).toEqual([]);
  });

  it("ends a watch when its thread leaves a live list, but not an offline one", () => {
    const home = watching("a");
    const first = run(new Map(), [thread("a")], home);
    const offline = run(first.next, [], home, { live: false });
    expect(offline.events).toEqual([]);
    expect(offline.next.has(homeWatchKey(studio, "a"))).toBe(true);
    expect(run(offline.next, [], home).events).toMatchObject([{ threadId: "a", kind: "ended" }]);
  });

  it("reports a launched thread even when watching all set its baseline first", () => {
    const fresh = { knownWatchKeys: new Set<string>() };
    const asking = [thread("a", { hasPendingApprovals: true })];
    const baseline = run(new Map(), asking, { ...watching(), watchAll: true }, fresh);
    expect(baseline.events).toEqual([]);
    const home = { ...watching("a"), watchAll: true };
    const watched = run(baseline.next, asking, home, fresh);
    expect(watched.events).toMatchObject([{ threadId: "a", kind: "approval" }]);
    expect(run(watched.next, asking, home, fresh).events).toEqual([]);
  });

  it("ends a start-up watch whose thread is already gone, once", () => {
    const home = watching("a");
    const first = run(new Map(), [], home);
    expect(first.events).toMatchObject([{ threadId: "a", kind: "ended" }]);
    expect(run(first.next, [], home).events).toEqual([]);
    // A new launch watch can arrive before its thread does.
    expect(run(new Map(), [], home, { knownWatchKeys: new Set() }).events).toEqual([]);
  });

  it("ends a start-up watch on a settled thread once its list is live", () => {
    const home = watching("a");
    const settled = [thread("a", { settledOverride: "settled" })];
    const cached = run(new Map(), settled, home, { live: false });
    expect(cached.events).toEqual([]);
    expect(cached.next.size).toBe(0);
    const live = run(cached.next, settled, home);
    expect(live.events).toMatchObject([{ threadId: "a", kind: "ended" }]);
    expect(run(live.next, settled, home).events).toEqual([]);
  });

  it("reports an agent run's completion but not one the user started in the thread", () => {
    const home = watching("a");
    const completed = (runId: string, requestedAt: string, completedAt: string) =>
      thread("a", {
        latestRun: { runId, status: "completed", requestedAt, completedAt },
        latestUserAuthoredMessageAt: "2026-10-03T10:00:00.000Z",
        runtime: null,
      } as Partial<EnvironmentThreadShell>);
    const first = run(new Map(), [thread("a")], home);

    const userRun = run(
      first.next,
      [completed("run-1", "2026-10-03T10:00:00.000Z", "2026-10-03T10:01:00.000Z")],
      home,
    );
    expect(userRun.events).toEqual([]);

    const agentRun = run(
      userRun.next,
      [completed("run-2", "2026-10-03T10:02:00.000Z", "2026-10-03T10:03:00.000Z")],
      home,
    );
    expect(agentRun.events).toMatchObject([{ threadId: "a", kind: "completed", runId: "run-2" }]);
  });
});

describe("dropSupersededCompletions", () => {
  it("drops a buffered completion once its thread has started a newer run", () => {
    const home = watching("a");
    const first = run(new Map(), [thread("a")], home);
    const done = run(
      first.next,
      [
        thread("a", {
          latestRun: {
            runId: "run-1",
            status: "completed",
            requestedAt: "2026-10-03T10:00:00.000Z",
            completedAt: "2026-10-03T10:01:00.000Z",
          },
          runtime: null,
        } as Partial<EnvironmentThreadShell>),
      ],
      home,
    );
    expect(done.events).toMatchObject([{ threadId: "a", kind: "completed", runId: "run-1" }]);

    // Run 2 is queued before the buffered batch is sent.
    const queued = [
      thread("a", {
        latestRun: { runId: "run-2", status: "queued", completedAt: null },
        runtime: { status: "queued", lastErrorClass: null },
      } as Partial<EnvironmentThreadShell>),
    ];
    expect(dropSupersededCompletions(done.events, queued)).toEqual([]);
    // Still the latest run: the completion goes out.
    expect(dropSupersededCompletions(done.events, [thread("a")])).toEqual(done.events);
  });
});
