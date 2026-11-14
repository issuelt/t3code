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

import type { SidebarThreadStatus, SidebarV2TopStatusKind } from "../Sidebar.logic";

// No shimmer: a label that animates forever is noise in a list full of them
// (and repaints every vsync on high-refresh displays).
export const SIDEBAR_TOP_STATUS: Record<
  SidebarV2TopStatusKind,
  { readonly label: string; readonly Icon: LucideIcon; readonly className: string }
> = {
  working: { label: "Working", Icon: CircleDashedIcon, className: "text-info-foreground" },
  waiting: { label: "Waiting", Icon: CircleDotDashedIcon, className: "text-muted-foreground" },
  approval: { label: "Approval", Icon: ShieldQuestionIcon, className: "text-warning-foreground" },
  input: {
    label: "Input",
    Icon: MessageCircleQuestionIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  request: { label: "Request", Icon: UserRoundIcon, className: "text-guest-foreground" },
  limited: { label: "Limited", Icon: CircleAlertIcon, className: "text-warning-foreground" },
  failed: { label: "Failed", Icon: CircleAlertIcon, className: "text-error-foreground" },
  woke: { label: "Woke", Icon: AlarmClockIcon, className: "text-warning-foreground" },
  done: { label: "Done", Icon: CircleCheckIcon, className: "text-success-foreground" },
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
