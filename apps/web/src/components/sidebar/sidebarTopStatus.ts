import {
  AlarmClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { msg } from "gt-react";

import type { SidebarThreadStatus, SidebarV2TopStatusKind } from "../Sidebar.logic";

// Labels are messages; resolve them where they render.
// No shimmer: a label that animates forever is noise in a list full of them
// (and repaints every vsync on high-refresh displays).
export const SIDEBAR_TOP_STATUS: Record<
  SidebarV2TopStatusKind,
  { readonly label: string; readonly Icon: LucideIcon; readonly className: string }
> = {
  working: {
    label: msg("Working", { $context: "thread status" }),
    Icon: CircleDashedIcon,
    className: "text-info-foreground",
  },
  waiting: {
    label: msg("Waiting", { $context: "thread status" }),
    Icon: CircleDotDashedIcon,
    className: "text-muted-foreground",
  },
  approval: {
    label: msg("Approval", { $context: "thread status: needs approval" }),
    Icon: ShieldQuestionIcon,
    className: "text-warning-foreground",
  },
  input: {
    label: msg("Input", { $context: "thread status: needs user input" }),
    Icon: MessageCircleQuestionIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  request: {
    label: msg("Request", { $context: "thread status: guest request" }),
    Icon: UserRoundIcon,
    className: "text-guest-foreground",
  },
  limited: {
    label: msg("Limited", { $context: "thread status: usage limited" }),
    Icon: CircleAlertIcon,
    className: "text-warning-foreground",
  },
  failed: {
    label: msg("Failed", { $context: "thread status" }),
    Icon: CircleAlertIcon,
    className: "text-error-foreground",
  },
  woke: {
    label: msg("Woke", { $context: "thread status: woke from snooze" }),
    Icon: AlarmClockIcon,
    className: "text-warning-foreground",
  },
  done: {
    label: msg("Done", { $context: "thread status" }),
    Icon: CircleCheckIcon,
    className: "text-success-foreground",
  },
};

export function sidebarTopStatusKind(
  status: SidebarThreadStatus,
  attention: { readonly isUnread: boolean; readonly isWoke?: boolean },
): SidebarV2TopStatusKind | null {
  if (status === "preparing") return "working";
  if (status !== "ready") return status;
  if (attention.isWoke) return "woke";
  return attention.isUnread ? "done" : null;
}
