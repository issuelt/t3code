import { memo } from "react";
import {
  HouseIcon,
  CircleDashedIcon,
  ShieldQuestionIcon,
  MessageCircleQuestionIcon,
  CircleAlertIcon,
  AlarmClockIcon,
  CircleCheckIcon,
  type LucideIcon,
} from "lucide-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useQuietThreadShell } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { cn } from "../../lib/utils";
import {
  hasUnseenCompletion,
  resolveThreadLastVisitedAt,
  resolveSidebarThreadStatus,
  resolveSidebarV2TopStatus,
  type SidebarV2TopStatusKind,
} from "../Sidebar.logic";
const SIDEBAR_TOP_STATUS: Record<
  SidebarV2TopStatusKind,
  { label: string; icon: SidebarV2TopStatusKind | null; Icon: LucideIcon | null; className: string }
> = {
  // No shimmer: a label that animates forever is noise in a sidebar full of
  // them (and repaints every vsync on high-refresh displays).
  working: { label: "Working", icon: "working", Icon: CircleDashedIcon, className: "text-info" },
  // Waiting is calm background presence (post-settle background roster), not
  // active progress, so the label keeps full strength.
  waiting: { label: "Waiting", icon: null, Icon: null, className: "text-muted-foreground" },
  approval: {
    label: "Approval",
    icon: "approval",
    Icon: ShieldQuestionIcon,
    className: "text-warning-foreground",
  },
  input: {
    label: "Input",
    icon: "input",
    Icon: MessageCircleQuestionIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  limited: { label: "Limited", icon: "failed", Icon: CircleAlertIcon, className: "text-warning" },
  failed: { label: "Failed", icon: "failed", Icon: CircleAlertIcon, className: "text-error" },
  woke: { label: "Woke", icon: "woke", Icon: AlarmClockIcon, className: "text-warning" },
  done: { label: "Done", icon: "done", Icon: CircleCheckIcon, className: "text-success" },
};

/**
 * The fixed row for the current Home thread, above every other row. Home has
 * no project, settle, or pin affordances, so it only shows its status.
 */
export const SidebarHomeRow = memo(function SidebarHomeRow(props: {
  threadRef: ScopedThreadRef;
  isActive: boolean;
  onActivate: (threadRef: ScopedThreadRef) => void;
}) {
  const { isActive, onActivate, threadRef } = props;
  const thread = useQuietThreadShell(threadRef);
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const topStatusKind =
    thread === null
      ? null
      : resolveSidebarV2TopStatus({
          status: resolveSidebarThreadStatus(thread),
          isUnread: hasUnseenCompletion({
            ...thread,
            lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
          }),
          isWoke: false,
        });
  const topStatus = topStatusKind === null ? null : SIDEBAR_TOP_STATUS[topStatusKind];
  const activate = () => onActivate(threadRef);
  return (
    <li className="list-none">
      <div
        role="button"
        tabIndex={0}
        aria-label={topStatus ? `Home, ${topStatus.label}` : "Home"}
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
        <span className="min-w-0 flex-1 truncate">Home</span>
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
