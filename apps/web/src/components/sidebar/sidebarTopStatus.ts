import {
  AlarmClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";

import type { SidebarV2TopStatusKind } from "../Sidebar.logic";

export const SIDEBAR_TOP_STATUS: Record<
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
  request: {
    label: "Request",
    icon: "request",
    Icon: UserRoundIcon,
    className: "text-guest-foreground",
  },
  limited: { label: "Limited", icon: "failed", Icon: CircleAlertIcon, className: "text-warning" },
  failed: { label: "Failed", icon: "failed", Icon: CircleAlertIcon, className: "text-error" },
  woke: { label: "Woke", icon: "woke", Icon: AlarmClockIcon, className: "text-warning" },
  done: { label: "Done", icon: "done", Icon: CircleCheckIcon, className: "text-success" },
};
