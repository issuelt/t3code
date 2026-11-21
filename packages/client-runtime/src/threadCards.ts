import type {
  ThreadPullRequestLink,
  ThreadPullRequestWatchCheckCounts,
  ThreadPullRequestWatchChecks,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

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

export function summarizeWatchChecks(
  counts: ThreadPullRequestWatchCheckCounts,
  resolve: MFunctionType = mFallback,
): string {
  const total = countedTotal(counts);
  if (counts.failed > 0)
    return resolve(msg("{count} of {total} failing", { count: counts.failed, total }));
  if (counts.awaiting > 0)
    return resolve(msg("{count} awaiting action", { count: counts.awaiting }));
  if (counts.running > 0)
    return resolve(
      msg("{count} of {total} running", { count: counts.running + counts.queued, total }),
    );
  if (counts.queued > 0)
    return resolve(msg("{count} of {total} queued", { count: counts.queued, total }));
  return counts.passed === total
    ? resolve(msg("All checks passed"))
    : resolve(msg("{count} of {total} passing", { count: counts.passed, total }));
}
