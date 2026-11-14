import type { ReactNode } from "react";

export function RequestCard({
  label,
  heading,
  actions,
  error,
  children,
}: {
  label: string;
  heading: ReactNode;
  actions: ReactNode;
  error: string | null;
  children?: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="rounded-lg border border-border bg-background p-3 text-xs"
    >
      <p className="mb-2 font-medium">{heading}</p>
      {children}
      <div className="mt-2 flex flex-wrap items-center gap-2">{actions}</div>
      {error !== null ? (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
