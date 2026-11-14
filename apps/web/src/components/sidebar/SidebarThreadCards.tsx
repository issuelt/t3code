import type {
  ProjectId,
  PullRequestRef,
  ScopedThreadRef,
  ThreadPullRequestLink,
  ThreadPullRequestWatchCheck,
  ThreadPullRequestWatchChecks,
} from "@t3tools/contracts";
import { summarizeWatchChecks, type ThreadCard } from "@t3tools/client-runtime/thread-cards";
import { threadPullRequestKeyOf } from "@t3tools/client-runtime/thread-pull-requests";
import { countPullRequestChecks } from "@t3tools/shared/threadPullRequests";
import { ChevronDownIcon, ChevronUpIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { threadEnvironment } from "~/state/threads";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { PullRequestCheckList } from "../pullRequest/PullRequestCheckList";
import { groupPullRequestChecks } from "../pullRequest/pullRequestDetail.logic";
import { PULL_REQUEST_WATCHING_HINT } from "../pullRequest/pullRequestPresentation";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const CARDS_PADDING_PX = 6;
const CARD_GAP_PX = 2;
const CARD_FRAME_PX = 10;
const CARD_HEADER_PX = 20;
const CHECK_LINE_PX = 16;
const CHECK_GAP_PX = 2;

/** Collapsed height of the cards, for an off-screen row's `contain-intrinsic-size`. */
export function threadCardsHeight(cards: ReadonlyArray<ThreadCard>): number {
  if (cards.length === 0) return 0;
  const heights = cards.map(({ checks, total }) => {
    const { attention, running } = groupPullRequestChecks(checks.runs);
    const rows = attention.length + running.length;
    const unlisted = total > checks.runs.length ? CHECK_LINE_PX : 0;
    const list = rows === 0 ? 0 : rows * (CHECK_LINE_PX + CHECK_GAP_PX) - CHECK_GAP_PX;
    return CARD_FRAME_PX + CARD_HEADER_PX + list + unlisted;
  });
  return (
    CARDS_PADDING_PX +
    (cards.length - 1) * CARD_GAP_PX +
    heights.reduce((sum, height) => sum + height, 0)
  );
}

export function SidebarThreadCards({
  threadRef,
  projectId,
  cards,
}: {
  threadRef: ScopedThreadRef;
  projectId: ProjectId;
  cards: ReadonlyArray<ThreadCard>;
}) {
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
  const stored = [...attention, ...running, ...(showAll ? completed : [])];
  const header = (summary: string) => (
    <ChecksCardHeader
      number={link.number}
      summary={summary}
      expandable={completed.length > 0 || unlisted > 0}
      showAll={showAll}
      onToggle={() => setShowAll(!showAll)}
      onStopWatching={() =>
        void watch({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            host: link.host,
            repository: link.repository,
            number: link.number,
            watching: false,
          },
        })
      }
    />
  );
  return (
    <section
      aria-label={`Checks for #${link.number}`}
      data-testid="sidebar-thread-checks-card"
      className="rounded-md border border-sidebar-border/70 px-2 py-1"
    >
      {showAll && unlisted > 0 ? (
        <AllChecks
          threadRef={threadRef}
          reference={{
            projectId,
            host: link.host,
            repository: link.repository,
            number: link.number,
          }}
          header={header}
          stored={stored}
          storedSummary={summarizeWatchChecks(checks.counts)}
          unlisted={unlisted}
        />
      ) : (
        <>
          {header(summarizeWatchChecks(checks.counts))}
          {stored.length > 0 ? (
            <PullRequestCheckList dense checks={stored} threadRef={threadRef} />
          ) : null}
          {unlisted > 0 ? <UnlistedChecks count={unlisted} /> : null}
        </>
      )}
    </section>
  );
}

function ChecksCardHeader({
  number,
  summary,
  expandable,
  showAll,
  onToggle,
  onStopWatching,
}: {
  number: number;
  summary: string;
  expandable: boolean;
  showAll: boolean;
  onToggle: () => void;
  onStopWatching: () => void;
}) {
  return (
    <div className="flex h-5 min-w-0 items-center gap-1.5 text-xs text-secondary-label">
      <span className="font-mono tabular-nums">#{number}</span>
      <span className="min-w-0 flex-1 truncate">{summary}</span>
      {expandable ? (
        <Button
          variant="ghost-muted"
          size="icon-micro"
          aria-expanded={showAll}
          aria-label={showAll ? "Show fewer checks" : "Show all checks"}
          onClick={onToggle}
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
              aria-label={`Stop watching #${number}`}
              onClick={onStopWatching}
            />
          }
        >
          <EyeIcon aria-hidden className="group-hover/watch:hidden" />
          <EyeOffIcon aria-hidden className="hidden group-hover/watch:block" />
        </TooltipTrigger>
        <TooltipPopup side="top">{PULL_REQUEST_WATCHING_HINT}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function UnlistedChecks({ count }: { count: number }) {
  return <p className="text-xs text-muted-foreground">{count} more on the pull request</p>;
}

function AllChecks({
  threadRef,
  reference,
  header,
  stored,
  storedSummary,
  unlisted,
}: {
  threadRef: ScopedThreadRef;
  reference: PullRequestRef;
  header: (summary: string) => ReactNode;
  stored: ReadonlyArray<ThreadPullRequestWatchCheck>;
  storedSummary: string;
  unlisted: number;
}) {
  const detailQuery = useEnvironmentQuery(
    pullRequestEnvironment.detail({ environmentId: threadRef.environmentId, input: reference }),
  );
  if (detailQuery.data === null) {
    return (
      <>
        {header(storedSummary)}
        <PullRequestCheckList dense checks={stored} threadRef={threadRef} />
        {detailQuery.isPending ? (
          <p className="text-xs text-muted-foreground">Loading checks…</p>
        ) : (
          <UnlistedChecks count={unlisted} />
        )}
      </>
    );
  }
  const loaded = detailQuery.data.checks.filter((check) => check.placeholder !== true);
  const { attention, running, completed } = groupPullRequestChecks(loaded);
  return (
    <>
      {header(summarizeWatchChecks(countPullRequestChecks(loaded)))}
      <PullRequestCheckList
        dense
        checks={[...attention, ...running, ...completed]}
        threadRef={threadRef}
      />
    </>
  );
}
