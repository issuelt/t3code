import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import {
  buildProjectGroups,
  derivePhysicalProjectKey,
  type ProjectGroupingSettings,
} from "./logicalProject";
import { resolveScratchProjectScopeKey } from "@t3tools/client-runtime/state/project-grouping";
import type { Project } from "./types";

export type EnvironmentPresence = "local-only" | "remote-only" | "mixed";

export interface SidebarProjectGroupMember extends Project {
  physicalProjectKey: string;
  environmentLabel: string | null;
}

export interface SidebarProjectSnapshot extends Project {
  projectKey: string;
  displayName: string;
  groupedProjectCount: number;
  environmentPresence: EnvironmentPresence;
  // True iff every non-primary member of this group lives in a
  // desktop-local environment. The sidebar uses this
  // to differentiate "lives on this machine but in a sandbox" from
  // "lives on a real remote" so the project header can pick a
  // local-device treatment instead of the generic remote treatment.
  allRemoteMembersAreDesktopLocal: boolean;
  allRemoteMembersAreWsl: boolean;
  memberProjects: readonly SidebarProjectGroupMember[];
  memberProjectRefs: readonly ScopedProjectRef[];
  remoteEnvironmentLabels: readonly string[];
}

export function projectGroupsSpanEnvironments(
  groups: ReadonlyArray<Pick<SidebarProjectSnapshot, "memberProjects">>,
): boolean {
  const environmentIds = new Set<EnvironmentId>();
  for (const group of groups) {
    for (const member of group.memberProjects) {
      environmentIds.add(member.environmentId);
      if (environmentIds.size > 1) return true;
    }
  }
  return false;
}

export interface SidebarProjectPickerEntry {
  group: SidebarProjectSnapshot;
  targetProject: SidebarProjectGroupMember;
  isPreferred: boolean;
}

/** A merged filter still opens settings for the chosen physical project. */
export function getSidebarProjectSettingsKey(
  group: SidebarProjectSnapshot,
  settings: ProjectGroupingSettings,
  projects: ReadonlyArray<Project>,
  projectRef?: ScopedProjectRef,
): string {
  if (!group.isScratch) return group.projectKey;
  const project =
    group.memberProjects.find(
      (member) =>
        member.environmentId === projectRef?.environmentId && member.id === projectRef.projectId,
    ) ??
    group.memberProjects.find((member) => member.environmentId === projectRef?.environmentId) ??
    group;
  return (
    buildPhysicalToLogicalProjectKeyMap({ projects, settings, primaryEnvironmentId: null }).get(
      derivePhysicalProjectKey(project),
    ) ?? group.projectKey
  );
}

/** Retains a saved physical scratch scope when its environment config coalesces the group. */
export function resolveSidebarProjectScopeKey(input: {
  readonly groups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly key: string | null;
  readonly settings?: ProjectGroupingSettings;
  readonly canClearMissingScope?: boolean;
}): string | null {
  if (input.key === null) return null;
  const group =
    input.groups.find((candidate) => candidate.projectKey === input.key) ??
    input.groups.find(
      (candidate) =>
        candidate.isScratch &&
        resolveScratchProjectScopeKey(input.key, candidate.memberProjects, input.settings) ===
          candidate.projectKey,
    );
  return group?.projectKey ?? (input.canClearMissingScope ? null : input.key);
}

export function buildPhysicalToLogicalProjectKeyMap(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
}): Map<string, string> {
  const mapping = new Map<string, string>();
  const groups = buildProjectGroups({
    projects: input.projects,
    settings: input.settings,
    preferredEnvironmentId: input.primaryEnvironmentId,
  });
  for (const group of groups) {
    for (const member of group.members) {
      mapping.set(member.physicalProjectKey, group.key);
    }
  }
  return mapping;
}

// The environment a group of sidebar projects lives in, used to render a
// quiet per-environment section header instead of a per-row cloud glyph.
//   - "local":         the primary environment (this machine / the connected host)
//   - "desktop-local":  a secondary backend that still runs on the user's own
//                       machine (today: the WSL backend) — a sandbox, not a real remote
//   - "remote":        a genuinely remote environment (server, SSH, relay, bearer)
export type SidebarEnvironmentGroupKind = "local" | "desktop-local" | "remote";

export interface SidebarProjectEnvironmentGroup {
  readonly environmentId: EnvironmentId;
  readonly kind: SidebarEnvironmentGroupKind;
  readonly label: string;
  readonly projects: readonly SidebarProjectSnapshot[];
}

// Pure grouping helper: partition already-sorted sidebar project snapshots into
// per-environment groups so the sidebar can render one quiet section header per
// environment (local machine vs each server) instead of a per-row cloud glyph.
//
// A project's group is its representative environment (the same environmentId
// buildSidebarProjectSnapshots picked — primary-preferred for cross-env grouped
// projects, so a repo that exists both locally and remotely lands in the local
// group). Group order: the primary/local group first, then the remaining groups
// in first-appearance order. Relative project order within each group is
// preserved exactly as given.
export function groupProjectsByEnvironment(input: {
  projects: readonly SidebarProjectSnapshot[];
  primaryEnvironmentId: EnvironmentId | null;
  resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
  // Returns true when an env id maps to a desktopLocal saved-env record
  // (today: the WSL backend). Defaults to "false for every env".
  isDesktopLocalEnvironment?: (environmentId: EnvironmentId) => boolean;
}): SidebarProjectEnvironmentGroup[] {
  const isDesktopLocal = input.isDesktopLocalEnvironment ?? (() => false);
  const membersByEnvironment = new Map<EnvironmentId, SidebarProjectSnapshot[]>();
  const environmentOrder: EnvironmentId[] = [];
  for (const project of input.projects) {
    const existing = membersByEnvironment.get(project.environmentId);
    if (existing) {
      existing.push(project);
    } else {
      membersByEnvironment.set(project.environmentId, [project]);
      environmentOrder.push(project.environmentId);
    }
  }

  // Local (primary) group first, then remaining environments in first-appearance
  // order — a deliberate ordering the owner can rely on (personal machine on top).
  const orderedEnvironmentIds = environmentOrder
    .filter((environmentId) => environmentId === input.primaryEnvironmentId)
    .concat(
      environmentOrder.filter((environmentId) => environmentId !== input.primaryEnvironmentId),
    );

  return orderedEnvironmentIds.map((environmentId) => {
    const kind: SidebarEnvironmentGroupKind =
      input.primaryEnvironmentId !== null && environmentId === input.primaryEnvironmentId
        ? "local"
        : isDesktopLocal(environmentId)
          ? "desktop-local"
          : "remote";
    const resolvedLabel = input.resolveEnvironmentLabel(environmentId);
    const fallbackLabel =
      kind === "local" ? "This machine" : kind === "desktop-local" ? "Local sandbox" : "Remote";
    return {
      environmentId,
      kind,
      label: resolvedLabel ?? fallbackLabel,
      projects: membersByEnvironment.get(environmentId) ?? [],
    };
  });
}

export function buildSidebarProjectSnapshots(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  groupScratchProjects?: boolean;
  primaryEnvironmentId: EnvironmentId | null;
  resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
  // Returns true when an env id maps to a desktop-local saved-env
  // record. Defaults to "false for every
  // env" so callers that don't care about the distinction get the
  // legacy behavior.
  isDesktopLocalEnvironment?: (environmentId: EnvironmentId) => boolean;
  isWslEnvironment?: (environmentId: EnvironmentId) => boolean;
}): SidebarProjectSnapshot[] {
  return buildProjectGroups({
    projects: input.projects,
    groupScratchProjects: input.groupScratchProjects ?? false,
    settings: input.settings,
    preferredEnvironmentId: input.primaryEnvironmentId,
  }).map((group): SidebarProjectSnapshot => {
    const members = group.members.map(
      ({ physicalProjectKey, project }): SidebarProjectGroupMember => ({
        ...project,
        physicalProjectKey,
        environmentLabel: input.resolveEnvironmentLabel(project.environmentId),
      }),
    );
    const representative =
      members.find(
        (member) =>
          member.environmentId === group.representative.environmentId &&
          member.id === group.representative.id,
      ) ?? members[0]!;

    const hasLocal =
      input.primaryEnvironmentId !== null &&
      members.some((member) => member.environmentId === input.primaryEnvironmentId);
    const hasRemote =
      input.primaryEnvironmentId !== null
        ? members.some((member) => member.environmentId !== input.primaryEnvironmentId)
        : false;
    const remoteMembers = members.filter(
      (member) =>
        input.primaryEnvironmentId !== null && member.environmentId !== input.primaryEnvironmentId,
    );
    const remoteEnvironmentLabels = remoteMembers
      .flatMap((member) => (member.environmentLabel ? [member.environmentLabel] : []))
      .filter((label, index, labels) => labels.indexOf(label) === index);
    const isDesktopLocal = input.isDesktopLocalEnvironment ?? (() => false);
    const isWsl = input.isWslEnvironment ?? (() => false);
    const allRemoteMembersAreDesktopLocal =
      remoteMembers.length > 0 &&
      remoteMembers.every((member) => isDesktopLocal(member.environmentId));
    const allRemoteMembersAreWsl =
      remoteMembers.length > 0 && remoteMembers.every((member) => isWsl(member.environmentId));

    return {
      ...representative,
      projectKey: group.key,
      displayName: group.label,
      groupedProjectCount: members.length,
      environmentPresence:
        hasLocal && hasRemote ? "mixed" : hasRemote ? "remote-only" : "local-only",
      allRemoteMembersAreDesktopLocal,
      allRemoteMembersAreWsl,
      memberProjects: members,
      memberProjectRefs: group.memberProjectRefs,
      remoteEnvironmentLabels,
    };
  });
}

export function buildSidebarProjectPickerEntries(input: {
  groups: ReadonlyArray<SidebarProjectSnapshot>;
  preferredProjectRef: ScopedProjectRef | null;
}) {
  const preferredProjectRef = input.preferredProjectRef;
  const entries = input.groups.flatMap((group): SidebarProjectPickerEntry[] => {
    const isPreferred = preferredProjectRef
      ? group.memberProjectRefs.some(
          (projectRef) =>
            projectRef.environmentId === preferredProjectRef.environmentId &&
            projectRef.projectId === preferredProjectRef.projectId,
        )
      : false;
    const preferredProject = preferredProjectRef
      ? (group.memberProjects.find(
          (project) =>
            project.environmentId === preferredProjectRef.environmentId &&
            project.id === preferredProjectRef.projectId,
        ) ??
        group.memberProjects.find(
          (project) => project.environmentId === preferredProjectRef.environmentId,
        ))
      : null;
    const targetProject =
      preferredProject ??
      group.memberProjects.find(
        (project) => project.environmentId === group.environmentId && project.id === group.id,
      ) ??
      group.memberProjects[0];
    if (!targetProject) return [];

    return [{ group, targetProject, isPreferred }];
  });
  const preferredIndex = entries.findIndex((entry) => entry.isPreferred);
  if (preferredIndex <= 0) return entries;

  return [
    entries[preferredIndex]!,
    ...entries.slice(0, preferredIndex),
    ...entries.slice(preferredIndex + 1),
  ];
}
