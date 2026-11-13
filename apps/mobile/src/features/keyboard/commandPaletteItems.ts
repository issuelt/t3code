import { withoutHomeProjects } from "@t3tools/client-runtime/state/projects";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { threadSearchSubject } from "@t3tools/client-runtime/state/thread-search";
import { isListedThreadLineage, type EnvironmentId } from "@t3tools/contracts";
import {
  foldSearchQuery,
  PALETTE_SECONDARY_LIMIT,
  PALETTE_THREAD_LIMIT,
  rankSearchGroups,
  scoreSearchTerms,
  scoreThreadSearch,
  type SearchMatchHint,
  type SearchRange,
  type SearchTermsMatch,
  threadRecentUse,
  type ThreadSearchSubject,
} from "@t3tools/shared/paletteSearch";

import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";

export interface CommandPaletteItem {
  readonly key: string;
  readonly kind: "action" | "project" | "thread";
  readonly project?: EnvironmentProject;
  readonly title: string;
  readonly detail?: string;
  readonly searchTerms: ReadonlyArray<string>;
  /** Thread rows rank by match quality and use instead of by `searchTerms`. */
  readonly threadSearch?: ThreadSearchSubject;
  /** Listed last in its group, as the thread already open. */
  readonly secondary?: boolean;
  readonly run: () => void;
}

export interface CommandPaletteResult extends CommandPaletteItem {
  /** Listed because its messages match; the row shows the message snippet. */
  readonly fromMessages?: boolean;
  /** Title ranges the query matched, for highlighting. */
  readonly titleRanges?: ReadonlyArray<SearchRange>;
  /** Shown in place of the detail when the match is not in the title. */
  readonly matchHint?: SearchMatchHint;
}

/**
 * Ranks like the web palette: actions, projects, and threads order by their
 * best match, threads by match quality and use. Threads whose messages match
 * come last, in `messageMatchKeys` order, so late server results never move
 * the rows above them.
 */
export function filterCommandPaletteItems(
  items: ReadonlyArray<CommandPaletteItem>,
  query: string,
  messageMatchKeys: ReadonlyArray<string>,
  now = Date.now(),
): CommandPaletteResult[] {
  const actionsOnly = query.startsWith(">");
  const normalizedQuery = foldSearchQuery(actionsOnly ? query.slice(1) : query);
  const candidates = actionsOnly ? items.filter((item) => item.kind === "action") : items;
  if (!normalizedQuery) return candidates.filter((item) => item.kind !== "project");

  // On equal match classes, groups keep this order, as on web.
  const kinds = ["action", "thread", "project"] as const;
  const groups = rankSearchGroups(
    kinds.map((kind) => ({ group: kind, items: candidates.filter((item) => item.kind === kind) })),
    (
      item,
      options,
    ): (SearchTermsMatch & { explain?: () => SearchMatchHint | undefined }) | null => {
      const match = item.threadSearch
        ? scoreThreadSearch(normalizedQuery, item.threadSearch, now, options)
        : scoreSearchTerms(normalizedQuery, [item.title, ...item.searchTerms], options);
      // The open thread, listed last, does not decide where its group sits.
      return match && item.secondary ? { ...match, groupQuality: 0 } : match;
    },
  );
  const threadsMatch = groups.some(({ group }) => group === "thread");
  const ranked = groups.flatMap(({ group, ranked: entries }) =>
    [...entries]
      // Stable, so rank order holds otherwise.
      .sort(
        (left, right) =>
          Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false),
      )
      .slice(
        0,
        group === "thread"
          ? PALETTE_THREAD_LIMIT
          : threadsMatch && !actionsOnly
            ? PALETTE_SECONDARY_LIMIT
            : entries.length,
      )
      .map(({ item, match }): CommandPaletteResult => {
        // Built only for the rows shown.
        const matchHint = match.explain?.();
        return { ...item, titleRanges: match.ranges, ...(matchHint ? { matchHint } : {}) };
      }),
  );
  if (actionsOnly) return ranked;

  const listed = new Set(ranked.map((item) => item.key));
  const threadByKey = new Map(
    items.filter((item) => item.kind === "thread").map((item) => [item.key, item]),
  );
  // `messageMatchKeys` arrive cut to what the palette shows; see `nextShownOrder`.
  const fromMessages = messageMatchKeys.flatMap((key) => {
    const item = threadByKey.get(key);
    return item && !listed.has(key) ? [{ ...item, fromMessages: true }] : [];
  });
  return [...ranked, ...fromMessages];
}

export function nextPaletteIndex(index: number, direction: -1 | 1, count: number) {
  return count === 0 ? 0 : (index + direction + count) % count;
}

/**
 * The palette's project and thread rows. New-thread rows leave out Home's folder; thread rows
 * keep every project's name, so older Home threads still show and match it.
 */
export function commandPaletteEntityItems(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly serverConfigs: ReadonlyMap<
    EnvironmentId,
    { readonly homeWorkspaceRoot?: string | undefined }
  >;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly activeThread: EnvironmentThreadShell | null;
  readonly environmentLabel: (environmentId: EnvironmentId) => string;
  /** Thread rows match environment names when there are several environments. */
  readonly searchEnvironments: boolean;
  readonly openDraft: (project: EnvironmentProject) => void;
  readonly openThread: (thread: EnvironmentThreadShell) => void;
}) {
  const newThreadProjects = withoutHomeProjects(input.projects, input.serverConfigs);
  const newThreadProjectByKey = new Map(
    newThreadProjects.map((project) => [
      scopedProjectKey(project.environmentId, project.id),
      project,
    ]),
  );
  const projectByKey = new Map(
    input.projects.map((project) => [scopedProjectKey(project.environmentId, project.id), project]),
  );
  const { activeThread } = input;
  const activeProject = activeThread
    ? (newThreadProjectByKey.get(
        scopedProjectKey(activeThread.environmentId, activeThread.projectId),
      ) ?? null)
    : null;
  const openProjects = newThreadProjects.filter((project) => project.archivedAt == null);
  const projectItems: CommandPaletteItem[] = [
    ...openProjects.filter((project) => project.pinnedAt != null),
    ...openProjects.filter((project) => project.pinnedAt == null),
  ].map((project) => ({
    key: `project:${scopedProjectKey(project.environmentId, project.id)}`,
    kind: "project",
    project,
    title: project.title,
    detail: `New thread · ${input.environmentLabel(project.environmentId)}`,
    searchTerms: [project.workspaceRoot, "new thread", "project"],
    run: () => input.openDraft(project),
  }));
  const threadItems: CommandPaletteItem[] = input.threads
    .filter((thread) => thread.archivedAt === null && isListedThreadLineage(thread.lineage))
    .map((thread) => {
      const project = projectByKey.get(scopedProjectKey(thread.environmentId, thread.projectId));
      const environment = input.environmentLabel(thread.environmentId);
      return {
        key: scopedThreadKey(thread.environmentId, thread.id),
        kind: "thread",
        title: thread.title || "Untitled thread",
        detail: [project?.title, environment].filter(Boolean).join(" · "),
        searchTerms: [],
        threadSearch: threadSearchSubject(
          thread,
          project?.title,
          input.searchEnvironments ? environment : null,
        ),
        // Last among threads: picking the thread already open does nothing.
        ...(thread.environmentId === activeThread?.environmentId && thread.id === activeThread.id
          ? { secondary: true }
          : {}),
        run: () => input.openThread(thread),
      };
    });
  // Recent means used recently: written in or opened, whichever is later.
  threadItems.sort(
    (left, right) =>
      (right.threadSearch ? threadRecentUse(right.threadSearch) : 0) -
      (left.threadSearch ? threadRecentUse(left.threadSearch) : 0),
  );
  return { activeProject, projectItems, threadItems };
}
