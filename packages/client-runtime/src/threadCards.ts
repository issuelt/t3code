import type { ThreadPullRequestLink, ThreadPullRequestWatchChecks } from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

export type ThreadCard = {
  readonly kind: "pull-request-checks";
  readonly link: ThreadPullRequestLink;
  readonly checks: ThreadPullRequestWatchChecks;
};

/** Cards a thread shows under its row: one per watched open pull request with checks. */
export function resolveThreadCards(
  pullRequests: ReadonlyArray<ThreadPullRequestLink> | undefined,
): ReadonlyArray<ThreadCard> {
  return visibleThreadPullRequests(pullRequests ?? []).flatMap((link): ReadonlyArray<ThreadCard> =>
    link.watch?.checks !== undefined &&
    link.watch.checks.total > 0 &&
    (link.snapshot === null || link.snapshot.state === "open")
      ? [{ kind: "pull-request-checks", link, checks: link.watch.checks }]
      : [],
  );
}
