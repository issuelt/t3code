import type {
  ScopedThreadRef,
  ThreadPullRequestLink,
  ThreadPullRequestWatchChecks,
} from "@t3tools/contracts";
import { resolveThreadCards } from "@t3tools/client-runtime/thread-cards";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";

import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { PullRequestCheckList } from "../pullRequest/PullRequestCheckList";
import { groupPullRequestChecks } from "../pullRequest/pullRequestDetail.logic";
import {
  PULL_REQUEST_WATCHING_HINT,
  summarizePullRequestChecks,
} from "../pullRequest/pullRequestPresentation";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarThreadCards({
  threadRef,
  pullRequests,
}: {
  threadRef: ScopedThreadRef;
  pullRequests: ReadonlyArray<ThreadPullRequestLink> | undefined;
}) {
  const cards = resolveThreadCards(pullRequests);
  if (cards.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5 px-(--sidebar-row-content-inset) pt-0.5 pb-1">
      {cards.map((card) => {
        switch (card.kind) {
          case "pull-request-checks":
            return (
              <PullRequestChecksCard
                key={`checks:${card.link.host}:${card.link.repository}#${card.link.number}`}
                threadRef={threadRef}
                link={card.link}
                checks={card.checks}
              />
            );
          default:
            return card.kind satisfies never;
        }
      })}
    </div>
  );
}

function PullRequestChecksCard({
  threadRef,
  link,
  checks,
}: {
  threadRef: ScopedThreadRef;
  link: ThreadPullRequestLink;
  checks: ThreadPullRequestWatchChecks;
}) {
  const [showAll, setShowAll] = useState(false);
  const watch = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: true });
  const { attention, running, completed } = groupPullRequestChecks(checks.runs);
  const visible = [...attention, ...running, ...(showAll ? completed : [])];
  const unlisted = checks.total - checks.runs.length;
  const stopWatching = () =>
    void watch({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        host: link.host,
        repository: link.repository,
        number: link.number,
        watching: false,
      },
    });
  return (
    <section
      aria-label={`Checks for #${link.number}`}
      data-testid="sidebar-thread-checks-card"
      className="rounded-md border border-sidebar-border/70 px-2 py-1"
    >
      <div className="flex h-5 min-w-0 items-center gap-1.5 text-2xs text-secondary-label">
        <span className="font-mono tabular-nums">#{link.number}</span>
        <span className="min-w-0 flex-1 truncate">{summarizePullRequestChecks(checks.runs)}</span>
        {completed.length > 0 ? (
          <Button
            variant="ghost-muted"
            size="micro"
            aria-expanded={showAll}
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? "Show less" : "Show all"}
          </Button>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-micro"
                className="group/watch"
                aria-label={`Stop watching #${link.number}`}
                onClick={stopWatching}
              />
            }
          >
            <EyeIcon aria-hidden className="group-hover/watch:hidden" />
            <EyeOffIcon aria-hidden className="hidden group-hover/watch:block" />
          </TooltipTrigger>
          <TooltipPopup side="top">{PULL_REQUEST_WATCHING_HINT}</TooltipPopup>
        </Tooltip>
      </div>
      {visible.length > 0 ? (
        <PullRequestCheckList dense checks={visible} threadRef={threadRef} />
      ) : null}
      {showAll && unlisted > 0 ? (
        <p className="text-2xs text-muted-foreground">{unlisted} more on the pull request</p>
      ) : null}
    </section>
  );
}
