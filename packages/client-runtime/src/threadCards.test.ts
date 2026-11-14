import type {
  ThreadPullRequestLink,
  ThreadPullRequestWatch,
  ThreadPullRequestWatchChecks,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadCards, summarizeWatchChecks } from "./threadCards.ts";

const AT = "2026-11-14T00:00:00.000Z";
const none = { failed: 0, awaiting: 0, running: 0, queued: 0, passed: 0, skipped: 0 };
const checks: ThreadPullRequestWatchChecks = {
  counts: { ...none, failed: 1 },
  runs: [{ name: "build", status: "failure", url: null }],
};
const watch: ThreadPullRequestWatch = {
  startedAt: AT,
  headSha: "abc1234",
  failedChecks: [],
  passed: false,
  passedChecks: [],
  remarksThrough: AT,
  remarkIds: [],
  conflicting: false,
  wakes: 0,
  checks,
};
const link = (
  number: number,
  overrides: Partial<ThreadPullRequestLink> = {},
): ThreadPullRequestLink => ({
  host: "git.example.test",
  repository: "acme/app",
  number,
  url: `https://git.example.test/acme/app/pull/${number}`,
  source: "agent",
  linkedAt: AT,
  snapshot: null,
  stack: null,
  watch,
  ...overrides,
});
const snapshot = (state: "open" | "merged"): ThreadPullRequestLink["snapshot"] => ({
  state,
  title: "Fixture",
  headBranch: "feature",
  baseBranch: "main",
  isDraft: false,
  updatedAt: null,
  syncedAt: AT,
});

describe("resolveThreadCards", () => {
  it("shows a checks card only for visible, open, watched pull requests with checks", () => {
    const cards = resolveThreadCards([
      link(1),
      link(2, { snapshot: snapshot("open") }),
      link(3, { snapshot: snapshot("merged") }),
      link(4, { watch: undefined, endedWatch: watch }),
      link(5, { watch: { ...watch, checks: undefined } }),
      link(6, { watch: { ...watch, checks: { counts: none, runs: [] } } }),
      link(7, { source: "stack-dismissed" }),
    ]);

    expect(cards.map((card) => [card.kind, card.link.number, card.checks, card.total])).toEqual([
      ["pull-request-checks", 1, checks, 1],
      ["pull-request-checks", 2, checks, 1],
    ]);
    expect(resolveThreadCards(undefined)).toEqual([]);
  });
});

describe("summarizeWatchChecks", () => {
  it.each([
    [{ ...none, failed: 1, running: 2, passed: 40 }, "1 of 43 failing"],
    [{ ...none, awaiting: 2, passed: 3 }, "2 awaiting action"],
    [{ ...none, running: 2, queued: 1, passed: 40 }, "2 running, 1 queued"],
    [{ ...none, running: 3, passed: 40 }, "3 of 43 running"],
    [{ ...none, queued: 3, passed: 40 }, "3 of 43 queued"],
    [{ ...none, passed: 40, skipped: 2 }, "40 of 42 passing"],
    [{ ...none, passed: 40 }, "All checks passed"],
  ])("counts every check, not only the stored runs: %j", (counts, summary) => {
    expect(summarizeWatchChecks(counts)).toBe(summary);
  });
});
