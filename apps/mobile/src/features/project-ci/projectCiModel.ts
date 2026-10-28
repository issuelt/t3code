import type { ProjectCiRemote, ProjectCiResult } from "@t3tools/contracts";

export type CiRun = ProjectCiResult["runs"][number];
export type CiFilter = "all" | "active" | "failed";

export function preferredCiRemote(remotes: readonly ProjectCiRemote[]) {
  const rank = (name: string) => (name === "upstream" ? 0 : name === "origin" ? 1 : 2);
  return (
    [...remotes].sort(
      (left, right) => rank(left.name) - rank(right.name) || left.name.localeCompare(right.name),
    )[0] ?? null
  );
}

export function ciRunActive(run: Pick<CiRun, "status">) {
  return [
    "queued",
    "in_progress",
    "pending",
    "running",
    "requested",
    "waiting",
    "created",
    "waiting_for_resource",
    "preparing",
    "scheduled",
  ].includes(run.status);
}

export function ciRunFailed(run: Pick<CiRun, "status" | "conclusion">) {
  return ["failure", "failed", "timed_out", "startup_failure", "action_required"].includes(
    run.conclusion ?? run.status,
  );
}

export function visibleCiRuns(runs: readonly CiRun[], filter: CiFilter, query: string) {
  const search = query.trim().toLowerCase();
  return runs
    .filter(
      (run) =>
        (filter === "all" || (filter === "active" ? ciRunActive(run) : ciRunFailed(run))) &&
        `${run.name} ${run.branch ?? ""} ${run.sha}`.toLowerCase().includes(search),
    )
    .sort(
      (left, right) =>
        Number(ciRunActive(right)) - Number(ciRunActive(left)) ||
        Number(ciRunFailed(right)) - Number(ciRunFailed(left)) ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    );
}
