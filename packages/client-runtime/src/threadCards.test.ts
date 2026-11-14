import type {
  ThreadPullRequestLink,
  ThreadPullRequestWatch,
  ThreadPullRequestWatchChecks,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadCards } from "./threadCards.ts";

const AT = "2026-11-14T00:00:00.000Z";
const checks: ThreadPullRequestWatchChecks = {
  total: 1,
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
      link(6, { watch: { ...watch, checks: { total: 0, runs: [] } } }),
      link(7, { source: "stack-dismissed" }),
    ]);

    expect(cards.map((card) => [card.kind, card.link.number, card.checks])).toEqual([
      ["pull-request-checks", 1, checks],
      ["pull-request-checks", 2, checks],
    ]);
    expect(resolveThreadCards(undefined)).toEqual([]);
  });
});
