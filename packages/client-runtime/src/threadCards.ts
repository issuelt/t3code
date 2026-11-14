import type {
  ThreadPullRequestLink,
  ThreadPullRequestWatchCheckCounts,
  ThreadPullRequestWatchChecks,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

export type ThreadCard = {
  readonly kind: "pull-request-checks";
  readonly link: ThreadPullRequestLink;
  readonly checks: ThreadPullRequestWatchChecks;
  readonly total: number;
};

const countedTotal = (counts: ThreadPullRequestWatchCheckCounts) =>
  counts.failed + counts.awaiting + counts.running + counts.queued + counts.passed + counts.skipped;

export function resolveThreadCards(
  pullRequests: ReadonlyArray<ThreadPullRequestLink> | undefined,
): ReadonlyArray<ThreadCard> {
  return visibleThreadPullRequests(pullRequests ?? []).flatMap(
    (link): ReadonlyArray<ThreadCard> => {
      const checks = link.watch?.checks;
      const total = checks === undefined ? 0 : countedTotal(checks.counts);
      return checks !== undefined &&
        total > 0 &&
        (link.snapshot === null || link.snapshot.state === "open")
        ? [{ kind: "pull-request-checks", link, checks, total }]
        : [];
    },
  );
}

export function summarizeWatchChecks(counts: ThreadPullRequestWatchCheckCounts): string {
  const total = countedTotal(counts);
  if (counts.failed > 0) return `${counts.failed} of ${total} failing`;
  if (counts.awaiting > 0) return `${counts.awaiting} awaiting action`;
  if (counts.running > 0) return `${counts.running + counts.queued} of ${total} running`;
  if (counts.queued > 0) return `${counts.queued} of ${total} queued`;
  return counts.passed === total ? "All checks passed" : `${counts.passed} of ${total} passing`;
}
