import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { MessageCircleQuestionIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "../../lib/utils";
import { openDecisions } from "../../state/threads";
import { Badge } from "../ui/badge";
import { SIDEBAR_TOP_STATUS } from "./sidebarTopStatus";

export const SidebarDecisionsRow = memo(function SidebarDecisionsRow() {
  const count = useAtomValue(openDecisions.askingThreadCountAtom);
  const isActive = useLocation({ select: (location) => location.pathname === "/decisions" });
  const navigate = useNavigate();
  if (count === 0) return null;
  const label = `Decisions, ${count} ${count === 1 ? "thread waits" : "threads wait"} on you`;
  return (
    <li className="list-none">
      <button
        type="button"
        aria-label={label}
        aria-current={isActive ? "page" : undefined}
        data-testid="sidebar-decisions-row"
        className={cn(
          "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm font-medium outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
        onClick={() => void navigate({ to: "/decisions" })}
      >
        <MessageCircleQuestionIcon
          aria-hidden
          className={cn("size-4 shrink-0", SIDEBAR_TOP_STATUS.input.className)}
        />
        <span className="min-w-0 flex-1 truncate">Decisions</span>
        <Badge size="sm" variant="secondary">
          {count}
        </Badge>
      </button>
    </li>
  );
});
