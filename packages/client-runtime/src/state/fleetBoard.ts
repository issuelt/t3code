import { type EnvironmentId, type HomeJob, isHomeLaunchedThreadId } from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";

type FleetShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "lineage"
  | "archivedAt"
  | "deletedAt"
  | "settledOverride"
  | "homeJob"
  | "updatedAt"
>;

export interface FleetChief<Shell extends FleetShell = EnvironmentThreadShell> {
  readonly shell: Shell;
  readonly environmentConnected: boolean;
}

export interface FleetJobGroup<Shell extends FleetShell = EnvironmentThreadShell> {
  readonly job: HomeJob | null;
  readonly chiefs: ReadonlyArray<FleetChief<Shell>>;
}

export function isFleetChief(shell: FleetShell): boolean {
  return (
    isHomeLaunchedThreadId(shell.id) &&
    shell.lineage.parentThreadId === null &&
    shell.archivedAt === null &&
    shell.deletedAt === null &&
    shell.settledOverride !== "settled"
  );
}

export function buildFleetBoard<Shell extends FleetShell>(
  shells: ReadonlyArray<Shell>,
  liveEnvironmentIds: ReadonlySet<EnvironmentId>,
): ReadonlyArray<FleetJobGroup<Shell>> {
  const byJob = new Map<HomeJob | null, Array<FleetChief<Shell>>>();
  for (const shell of shells) {
    if (!isFleetChief(shell)) continue;
    const chief = { shell, environmentConnected: liveEnvironmentIds.has(shell.environmentId) };
    const chiefs = byJob.get(shell.homeJob);
    if (chiefs === undefined) byJob.set(shell.homeJob, [chief]);
    else chiefs.push(chief);
  }
  const newestFirst = (left: FleetChief<Shell>, right: FleetChief<Shell>) =>
    right.shell.updatedAt.localeCompare(left.shell.updatedAt);
  return [...byJob]
    .map(([job, chiefs]) => ({ job, chiefs: chiefs.sort(newestFirst) }))
    .sort((left, right) => newestFirst(left.chiefs[0]!, right.chiefs[0]!));
}
