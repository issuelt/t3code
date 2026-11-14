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
  type SidebarV2TopStatusKind,
} from "../Sidebar.logic";
import { SIDEBAR_TOP_STATUS, sidebarTopStatusKind } from "./sidebarTopStatus";
import { SidebarTopRow } from "./SidebarTopRow";

// Home keeps its brighter tones, and Waiting shows no icon: it is calm background presence.
const HOME_STATUS_TONE: Partial<Record<SidebarV2TopStatusKind, string>> = {
  working: "text-info",
  limited: "text-warning",
  failed: "text-error",
  woke: "text-warning",
  done: "text-success",
};

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
      : sidebarTopStatusKind(resolveSidebarThreadStatus(thread), {
          isUnread: hasUnseenCompletion({
            ...thread,
            lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
          }),
        });
  const topStatus = topStatusKind === null ? null : SIDEBAR_TOP_STATUS[topStatusKind];
  return (
    <SidebarTopRow
      label={topStatus ? `${label}, ${topStatus.label}` : label}
      isActive={isActive}
      testId="sidebar-home-row"
      icon={<HouseIcon aria-hidden className="size-4 shrink-0" />}
      title={label}
      onActivate={() => onActivate(threadRef)}
      trailing={
        topStatusKind !== null && topStatus ? (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 text-xs font-medium",
              HOME_STATUS_TONE[topStatusKind] ?? topStatus.className,
            )}
          >
            {topStatusKind === "waiting" ? null : (
              <topStatus.Icon aria-hidden className="size-4 shrink-0" />
            )}
            <span role="status">{topStatus.label}</span>
          </span>
        ) : null
      }
    />
  );
});
