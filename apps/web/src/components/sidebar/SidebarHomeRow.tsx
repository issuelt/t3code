import { memo } from "react";
import { HouseIcon } from "lucide-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useQuietThreadShell } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { cn } from "../../lib/utils";
import {
  hasUnseenCompletion,
  resolveThreadLastVisitedAt,
  resolveSidebarThreadStatus,
  type SidebarThreadStatus,
  type SidebarV2TopStatusKind,
} from "../Sidebar.logic";
import { SIDEBAR_TOP_STATUS } from "./sidebarTopStatus";

function homeTopStatus(
  status: SidebarThreadStatus,
  isUnread: boolean,
): SidebarV2TopStatusKind | null {
  if (status === "preparing") return "working";
  if (status !== "ready") return status;
  return isUnread ? "done" : null;
}
/**
 * The fixed row for the current Home thread, above every other row. Home has
 * no project, settle, or pin affordances, so it only shows its status.
 */
export const SidebarHomeRow = memo(function SidebarHomeRow(props: {
  threadRef: ScopedThreadRef;
  /** Names the machine when more than one environment runs Home. */
  environmentLabel: string | null;
  isActive: boolean;
  onActivate: (threadRef: ScopedThreadRef) => void;
}) {
  const { environmentLabel, isActive, onActivate, threadRef } = props;
  const label = environmentLabel === null ? "Home" : `Home · ${environmentLabel}`;
  const thread = useQuietThreadShell(threadRef);
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const topStatusKind =
    thread === null
      ? null
      : homeTopStatus(
          resolveSidebarThreadStatus(thread),
          hasUnseenCompletion({
            ...thread,
            lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
          }),
        );
  const topStatus = topStatusKind === null ? null : SIDEBAR_TOP_STATUS[topStatusKind];
  const activate = () => onActivate(threadRef);
  return (
    <li className="list-none">
      <div
        role="button"
        tabIndex={0}
        aria-label={topStatus ? `${label}, ${topStatus.label}` : label}
        aria-current={isActive ? "page" : undefined}
        data-testid="sidebar-home-row"
        className={cn(
          "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm font-medium outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          activate();
        }}
      >
        <HouseIcon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {topStatus ? (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 text-xs font-medium",
              topStatus.className,
            )}
          >
            {topStatus.Icon ? <topStatus.Icon aria-hidden className="size-4 shrink-0" /> : null}
            <span role="status">{topStatus.label}</span>
          </span>
        ) : null}
      </div>
    </li>
  );
});
