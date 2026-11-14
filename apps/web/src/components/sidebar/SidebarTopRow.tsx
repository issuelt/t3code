import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

export function SidebarTopRow({
  label,
  isActive,
  testId,
  icon,
  title,
  trailing,
  onActivate,
}: {
  label: string;
  isActive: boolean;
  testId: string;
  icon: ReactNode;
  title: string;
  trailing: ReactNode;
  onActivate: () => void;
}) {
  return (
    <li className="list-none">
      <div
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-current={isActive ? "page" : undefined}
        data-testid={testId}
        className={cn(
          "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm font-medium outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
        onClick={onActivate}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onActivate();
        }}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {trailing}
      </div>
    </li>
  );
}
