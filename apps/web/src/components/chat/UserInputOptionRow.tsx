import type { ScopedThreadRef } from "@t3tools/contracts";
import { textDirection } from "~/textDirection";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { CheckboxMark } from "../ui/checkbox";
import { Kbd } from "../ui/kbd";

export function UserInputOptionRow({
  option,
  multiSelect,
  selected,
  disabled,
  onSelect,
  shortcut,
  className,
  cwd,
  threadRef,
}: {
  option: {
    readonly label: string;
    readonly description?: string | undefined;
    readonly preview?: string | undefined;
  };
  multiSelect: boolean;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  shortcut?: number | undefined;
  className?: string | undefined;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
}) {
  // The preview sits outside the button: it can hold links, and a click on a single-select option advances.
  return (
    <div>
      <button
        type="button"
        aria-pressed={selected}
        disabled={disabled}
        onClick={onSelect}
        className={cn(
          "group flex w-full items-start gap-2.5 rounded-md bg-transparent py-1.5 ps-2 text-start sm:ps-1.5 outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/25",
          selected ? "text-foreground" : "text-foreground/70 hover:bg-muted/30",
          disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
          className,
        )}
      >
        {/* The h-5 slots match the label's line box, so the indicator and shortcut stay on its first line. */}
        <span className="pointer-events-none flex h-5 shrink-0 items-center">
          {multiSelect ? (
            <CheckboxMark checked={selected} variant="contrast" />
          ) : (
            <OptionRadio checked={selected} />
          )}
        </span>
        <div className="min-w-0 flex-1 flex flex-col gap-0.5">
          <span className="text-sm font-medium" dir={textDirection(option.label)}>
            {option.label}
          </span>
          {option.description && option.description !== option.label ? (
            <span className="text-secondary-label text-2xs" dir={textDirection(option.description)}>
              {option.description}
            </span>
          ) : null}
        </div>
        {shortcut === undefined ? null : (
          <span className="flex h-5 w-7 shrink-0 items-center justify-center sm:w-6">
            <Kbd>{shortcut}</Kbd>
          </span>
        )}
      </button>
      {option.preview ? (
        <ChatMarkdown
          text={option.preview}
          cwd={cwd}
          threadRef={threadRef}
          lineBreaks
          className="ps-9 pe-2 pb-1.5 text-xs text-foreground/70 sm:ps-8"
        />
      ) : null}
    </div>
  );
}

// Drawn with ui/radio-group's look instead of using its Radio: Radio only checks inside a
// RadioGroup, whose arrow keys select options and would trip the single-select auto-advance.
function OptionRadio({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-full border border-foreground/55 bg-background not-dark:bg-clip-padding sm:size-4 dark:bg-input/32",
        checked ? "shadow-none" : "shadow-xs/5",
      )}
    >
      {checked ? (
        <span className="-inset-px absolute flex items-center justify-center rounded-full bg-primary before:size-2 before:rounded-full before:bg-primary-foreground sm:before:size-1.5" />
      ) : null}
    </span>
  );
}
