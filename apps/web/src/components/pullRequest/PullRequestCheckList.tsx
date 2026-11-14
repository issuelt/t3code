import type { PullRequestCheck, ScopedThreadRef } from "@t3tools/contracts";

import { useOpenLink } from "~/browser/useOpenLink";
import { cn } from "~/lib/utils";

import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestCheckStatusIcon, pullRequestCheckStatusLabel } from "./pullRequestPresentation";

export type PullRequestCheckListItem = Pick<PullRequestCheck, "name" | "status" | "phase" | "url"> &
  Partial<Pick<PullRequestCheck, "description">>;

export function PullRequestCheckList({
  checks,
  threadRef,
  dense = false,
}: {
  checks: ReadonlyArray<PullRequestCheckListItem>;
  threadRef: ScopedThreadRef | null;
  dense?: boolean;
}) {
  const openLink = useOpenLink(threadRef);
  const open = (url: string | null) => {
    if (url === null) return;
    void openLink(url).catch((error: unknown) => {
      console.error(error);
      toastManager.add({ type: "error", title: "Unable to open check details" });
    });
  };
  const hasDetails = !dense && checks.some((check) => check.url !== null);
  return (
    <ul
      className={cn(
        "grid gap-x-2",
        dense ? "gap-y-0.5 text-2xs" : "gap-y-1 text-xs",
        hasDetails
          ? "grid-cols-[auto_minmax(0,1fr)_auto_auto]"
          : "grid-cols-[auto_minmax(0,1fr)_auto]",
      )}
    >
      {checks.map(
        (check, index) => (
          /* oxlint-disable react/no-array-index-key -- Check names can repeat; these status rows have no local state. */ <li
            key={`${index}:${check.name}`}
            className="col-span-full grid grid-cols-subgrid items-center"
          >
            <PullRequestCheckStatusIcon
              status={check.status}
              phase={check.phase}
              still={dense}
              {...(dense && { className: "size-3" })}
            />
            {dense && check.url !== null ? (
              <button
                type="button"
                className="min-w-0 truncate text-left hover:underline"
                onClick={() => open(check.url)}
              >
                {check.name}
              </button>
            ) : (
              <Tooltip>
                <TooltipTrigger render={<span className="min-w-0 truncate">{check.name}</span>} />
                <TooltipPopup side="top">{check.description ?? check.name}</TooltipPopup>
              </Tooltip>
            )}
            <span className="justify-self-end whitespace-nowrap text-muted-foreground">
              {pullRequestCheckStatusLabel(check)}
            </span>
            {hasDetails && check.url !== null ? (
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => open(check.url)}
              >
                Details
              </button>
            ) : null}
          </li>
        ) /* oxlint-enable react/no-array-index-key */,
      )}
    </ul>
  );
}
