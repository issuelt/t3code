import type {
  ProjectId,
  PullRequestRef,
  ScopedThreadRef,
  ThreadPullRequestLink,
  ThreadPullRequestWatchCheck,
  ThreadPullRequestWatchChecks,
} from "@t3tools/contracts";
import { resolveThreadCards, summarizeWatchChecks } from "@t3tools/client-runtime/thread-cards";
import { threadPullRequestKeyOf } from "@t3tools/client-runtime/thread-pull-requests";
import { ChevronDownIcon, ChevronUpIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";

import { threadEnvironment } from "~/state/threads";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { PullRequestCheckList } from "../pullRequest/PullRequestCheckList";
import { groupPullRequestChecks } from "../pullRequest/pullRequestDetail.logic";
import { PULL_REQUEST_WATCHING_HINT } from "../pullRequest/pullRequestPresentation";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarThreadCards({
  threadRef,
  projectId,
  pullRequests,
}: {
  threadRef: ScopedThreadRef;
  projectId: ProjectId;
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
                key={threadPullRequestKeyOf(card.link)}
                threadRef={threadRef}
                projectId={projectId}
                link={card.link}
                checks={card.checks}
                total={card.total}
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
  projectId,
  link,
  checks,
  total,
}: {
  threadRef: ScopedThreadRef;
  projectId: ProjectId;
  link: ThreadPullRequestLink;
  checks: ThreadPullRequestWatchChecks;
  total: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const watch = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: true });
  const { attention, running, completed } = groupPullRequestChecks(checks.runs);
  const unlisted = total - checks.runs.length;
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
  const stored = [...attention, ...running, ...(showAll ? completed : [])];
  return (
    <section
      aria-label={`Checks for #${link.number}`}
      data-testid="sidebar-thread-checks-card"
      className="rounded-md border border-sidebar-border/70 px-2 py-1"
    >
      <div className="flex h-5 min-w-0 items-center gap-1.5 text-2xs text-secondary-label">
        <span className="font-mono tabular-nums">#{link.number}</span>
        <span className="min-w-0 flex-1 truncate">{summarizeWatchChecks(checks.counts)}</span>
        {completed.length > 0 || unlisted > 0 ? (
          <Button
            variant="ghost-muted"
            size="icon-micro"
            aria-expanded={showAll}
            aria-label={showAll ? "Show fewer checks" : "Show all checks"}
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? <ChevronUpIcon aria-hidden /> : <ChevronDownIcon aria-hidden />}
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
      {showAll && unlisted > 0 ? (
        <AllChecks
          threadRef={threadRef}
          reference={{
            projectId,
            host: link.host,
            repository: link.repository,
            number: link.number,
          }}
          stored={stored}
          unlisted={unlisted}
        />
      ) : (
        <>
          {stored.length > 0 ? (
            <PullRequestCheckList dense checks={stored} threadRef={threadRef} />
          ) : null}
          {unlisted > 0 ? <UnlistedChecks count={unlisted} /> : null}
        </>
      )}
    </section>
  );
}

function UnlistedChecks({ count }: { count: number }) {
  return <p className="text-2xs text-muted-foreground">{count} more on the pull request</p>;
}

function AllChecks({
  threadRef,
  reference,
  stored,
  unlisted,
}: {
  threadRef: ScopedThreadRef;
  reference: PullRequestRef;
  stored: ReadonlyArray<ThreadPullRequestWatchCheck>;
  unlisted: number;
}) {
  const detailQuery = useEnvironmentQuery(
    pullRequestEnvironment.detail({ environmentId: threadRef.environmentId, input: reference }),
  );
  if (detailQuery.data === null) {
    return (
      <>
        <PullRequestCheckList dense checks={stored} threadRef={threadRef} />
        {detailQuery.isPending ? (
          <p className="text-2xs text-muted-foreground">Loading checks…</p>
        ) : (
          <UnlistedChecks count={unlisted} />
        )}
      </>
    );
  }
  const { attention, running, completed } = groupPullRequestChecks(detailQuery.data.checks);
  return (
    <PullRequestCheckList
      dense
      checks={[...attention, ...running, ...completed]}
      threadRef={threadRef}
    />
  );
}
