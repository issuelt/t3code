import type * as React from "react";
import type {
  EnvironmentId,
  PullRequestCheck,
  PullRequestChecksState,
  PullRequestRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { PullRequestCheckList } from "./PullRequestCheckList";
import { groupPullRequestChecks } from "./pullRequestDetail.logic";
import {
  pullRequestChecksStatePresentation,
  summarizePullRequestChecks,
} from "./pullRequestPresentation";

// Fetch only on open to avoid per-row requests.
function LazyChecksBody({
  environmentId,
  reference,
  threadRef,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  threadRef: ScopedThreadRef | null;
}) {
  const detailQuery = useEnvironmentQuery(
    pullRequestEnvironment.detail({ environmentId, input: reference }),
  );
  if (detailQuery.error !== null) {
    return <p className="text-muted-foreground text-xs">{detailQuery.error}</p>;
  }
  if (detailQuery.data === null) {
    return (
      <p className="text-muted-foreground text-xs">
        {detailQuery.isPending ? "Loading checks…" : "No checks reported"}
      </p>
    );
  }
  return <ChecksBody checks={detailQuery.data.checks} threadRef={threadRef} />;
}

function ChecksBody({
  checks,
  threadRef,
}: {
  checks: ReadonlyArray<PullRequestCheck>;
  threadRef: ScopedThreadRef | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const { attention, running, completed } = groupPullRequestChecks(checks);
  const canCollapse = attention.length + running.length > 0 && completed.length > 0;
  if (checks.length === 0) {
    return <p className="text-muted-foreground text-xs">No checks reported</p>;
  }
  return (
    <>
      <ScrollArea className="-me-3 w-auto max-h-64">
        <div className="pe-3">
          <PullRequestCheckList
            checks={[...attention, ...running, ...(showAll || !canCollapse ? completed : [])]}
            threadRef={threadRef}
          />
        </div>
      </ScrollArea>
      {canCollapse ? (
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? "Show less" : "Show all"}
        </Button>
      ) : null}
    </>
  );
}

export function PullRequestChecksPopover({
  checksState,
  checks,
  stale = false,
  environmentId,
  reference,
  threadRef = null,
  variant = "icon",
  className,
  render,
}: {
  checksState: PullRequestChecksState;
  checks?: ReadonlyArray<PullRequestCheck>;
  stale?: boolean;
  environmentId?: EnvironmentId;
  reference?: PullRequestRef;
  threadRef?: ScopedThreadRef | null;
  variant?: "icon" | "count";
  className?: string;
  render?: React.ReactElement;
}) {
  const presentation = pullRequestChecksStatePresentation(checksState);
  const incompleteCount =
    checks?.filter((check) => check.status === "pending" || check.status === "action-required")
      .length ?? 0;
  const failedCount =
    checks?.filter((check) => check.status === "failure" || check.status === "cancelled").length ??
    0;
  const summary = checks === undefined || stale ? null : summarizePullRequestChecks(checks);
  return (
    <Popover>
      <PopoverTrigger
        nativeButton={variant === "count"}
        aria-label={
          variant === "count"
            ? `Open checks: ${summary ?? presentation.label}`
            : `Checks: ${presentation.label}`
        }
        render={
          variant === "count" ? (
            (render ?? <Button variant="ghost" size="sm" className={className} />)
          ) : (
            <span
              role="button"
              tabIndex={0}
              className={cn("inline-flex shrink-0 cursor-pointer items-center", className)}
            />
          )
        }
        onClick={(event) => event.stopPropagation()}
      >
        <presentation.Icon aria-hidden className={cn("size-3.5", presentation.toneClassName)} />
        {variant === "count" ? (
          <>
            {checks !== undefined && incompleteCount > 0 ? (
              // Clip the second line so "checks" disappears whole when the count must shrink.
              <span className="h-lh min-w-0 overflow-hidden text-left whitespace-normal tabular-nums">
                <span className="whitespace-nowrap">
                  {checks.length - incompleteCount}/{checks.length}
                </span>{" "}
                checks
              </span>
            ) : failedCount > 0 ? (
              <span className="min-w-0 truncate tabular-nums">{failedCount} failed</span>
            ) : null}
          </>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="start" width="md" side="bottom">
        <p className="mb-2 font-medium text-sm">{presentation.label}</p>
        {summary === null ? null : <p className="mb-2 text-muted-foreground text-xs">{summary}</p>}
        {stale ? (
          <p className="text-muted-foreground text-xs">
            Check details are out of date. Refresh the pull request to update them.
          </p>
        ) : checks !== undefined ? (
          <ChecksBody checks={checks} threadRef={threadRef} />
        ) : environmentId !== undefined && reference !== undefined ? (
          <LazyChecksBody
            environmentId={environmentId}
            reference={reference}
            threadRef={threadRef}
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
