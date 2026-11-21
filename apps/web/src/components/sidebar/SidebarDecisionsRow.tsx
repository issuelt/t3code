import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { MessageCircleQuestionIcon } from "lucide-react";
import { useGT } from "gt-react";
import { memo } from "react";

import { cn } from "../../lib/utils";
import { openDecisions } from "../../state/threads";
import { SIDEBAR_TOP_STATUS } from "./sidebarTopStatus";
import { SidebarTopRow } from "./SidebarTopRow";

export const SidebarDecisionsRow = memo(function SidebarDecisionsRow() {
  const count = useAtomValue(openDecisions.askingThreadCountAtom);
  const isActive = useLocation({ select: (location) => location.pathname === "/decisions" });
  const navigate = useNavigate();
  const gt = useGT();
  if (count === 0) return null;
  const waiting = gt("{count, plural, one {{count} thread} other {{count} threads}}", { count });
  return (
    <SidebarTopRow
      label={gt("Decisions, {waiting} waiting on you", { waiting })}
      isActive={isActive}
      testId="sidebar-decisions-row"
      icon={
        <MessageCircleQuestionIcon
          aria-hidden
          className={cn("size-4 shrink-0", SIDEBAR_TOP_STATUS.input.className)}
        />
      }
      title={gt("Decisions")}
      onActivate={() => void navigate({ to: "/decisions" })}
      trailing={
        <span className="shrink-0 text-xs font-medium text-muted-foreground">{waiting}</span>
      }
    />
  );
});
