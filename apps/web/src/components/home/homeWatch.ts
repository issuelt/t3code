import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  type EnvironmentId,
  type HomeSettings,
  type HomeWatchEvent,
  isHomeThreadId,
  type ThreadId,
  RunId,
} from "@t3tools/contracts";

import { resolveSidebarThreadStatus } from "../Sidebar.logic";

export interface WatchedThreadState {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  /** The pending requests already reported, as `status:identity`. */
  readonly attention: ReadonlyArray<string> | null;
  readonly completion: number | null;
  readonly ended: boolean;
  /** Set once a launch watch added after start-up has been compared with an empty state. */
  readonly launchSeen: boolean;
}

export const homeWatchKey = (environmentId: string, threadId: string) =>
  `${environmentId}\u0000${threadId}`;

const UNSEEN = { attention: null, completion: null, ended: false };

/** The user already watched a run they started inside the thread, so its end is not news to Home. */
function startedByUser(thread: EnvironmentThreadShell): boolean {
  const authoredAt = Date.parse(thread.latestUserAuthoredMessageAt ?? "");
  const requestedAt = Date.parse(thread.latestRun?.requestedAt ?? "");
  return Number.isFinite(authoredAt) && Number.isFinite(requestedAt) && authoredAt >= requestedAt;
}

/**
 * Drops buffered completions whose thread has since started a newer run, such
 * as a child's result starting its parent's next run. Called at send time with
 * the current shells.
 */
export function dropSupersededCompletions(
  events: ReadonlyArray<HomeWatchEvent>,
  shells: ReadonlyArray<EnvironmentThreadShell>,
): Array<HomeWatchEvent> {
  const latestRuns = new Map(
    shells.map((shell) => [homeWatchKey(shell.environmentId, shell.id), shell.latestRun?.runId]),
  );
  return events.filter((event) => {
    if (event.kind !== "completed" || event.runId === undefined) return true;
    const latest = latestRuns.get(homeWatchKey(event.environmentId, event.threadId));
    return latest === undefined || latest === event.runId;
  });
}

/**
 * The pending requests each thread's children roll up to it, keyed by
 * `homeWatchKey`: approvals up the subagent and side-chat chain, and a side
 * chat's question to its direct parent. Each request keeps its child's
 * identity across the parent's runs.
 */
function childRequestsByParent(shells: ReadonlyArray<EnvironmentThreadShell>) {
  const byKey = new Map(
    shells.map((shell) => [homeWatchKey(shell.environmentId, shell.id), shell]),
  );
  const requests = new Map<string, { approval: Array<string>; question: Array<string> }>();
  const add = (key: string, kind: "approval" | "question", request: string) => {
    let entry = requests.get(key);
    if (entry === undefined) requests.set(key, (entry = { approval: [], question: [] }));
    entry[kind].push(request);
  };
  for (const child of shells) {
    const parentId = child.lineage.parentThreadId;
    if (child.lineage.sideChat === true && parentId !== null && child.pendingUserInputAt != null) {
      add(
        homeWatchKey(child.environmentId, parentId),
        "question",
        `${child.id}@${child.pendingUserInputAt}`,
      );
    }
    const at = child.pendingApprovalAt;
    if (at == null) continue;
    let current = child;
    const seen = new Set<string>();
    while (
      current.lineage.relationshipToParent === "subagent" ||
      current.lineage.sideChat === true
    ) {
      const nextId = current.lineage.parentThreadId;
      if (nextId === null) break;
      const key = homeWatchKey(current.environmentId, nextId);
      if (seen.has(key)) break;
      seen.add(key);
      add(key, "approval", `${child.id}@${at}`);
      const parent = byKey.get(key);
      if (parent === undefined) break;
      current = parent;
    }
  }
  return requests;
}

/**
 * First sight of a thread only sets a baseline, except threads launched after
 * start (not in `knownWatchKeys`), which compare against empty state. Only live
 * lists count: cached ones keep last state, and in a live list a missing or
 * settled watched thread ends its watch.
 */
export function diffWatchedThreads(input: {
  readonly previous: ReadonlyMap<string, WatchedThreadState>;
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly home: HomeSettings;
  readonly knownWatchKeys: ReadonlySet<string>;
  readonly liveEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly labelFor: (environmentId: EnvironmentId) => string | undefined;
}): { readonly next: Map<string, WatchedThreadState>; readonly events: Array<HomeWatchEvent> } {
  const watches = new Map(
    input.home.watches.map((watch) => [homeWatchKey(watch.environmentId, watch.threadId), watch]),
  );
  const present = new Set<string>();
  const next = new Map<string, WatchedThreadState>();
  const events: Array<HomeWatchEvent> = [];
  const eventBase = (state: WatchedThreadState) => {
    const label = input.labelFor(state.environmentId);
    return {
      environmentId: state.environmentId,
      threadId: state.threadId,
      title: state.title.slice(0, 300),
      ...(label === undefined ? {} : { environmentLabel: label.slice(0, 200) }),
    };
  };
  let childRequests: ReturnType<typeof childRequestsByParent> | undefined;
  for (const thread of input.shells) {
    const key = homeWatchKey(thread.environmentId, thread.id);
    present.add(key);
    // Home never wakes for itself, an older Home, or subagent plumbing.
    if (isHomeThreadId(thread.id) || thread.lineage.relationshipToParent === "subagent") continue;
    const watch = watches.get(key);
    if (!input.home.watchAll && watch === undefined) continue;
    let status = resolveSidebarThreadStatus(thread);
    if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
    const fresh = watch?.reason === "launched" && !input.knownWatchKeys.has(key);
    const seen = input.previous.get(key);
    // A first look counts only in a live list; a cached one may be stale.
    if (seen === undefined && !input.liveEnvironmentIds.has(thread.environmentId)) continue;
    const prior = fresh && seen?.launchSeen !== true ? UNSEEN : seen;
    const attentionKind =
      status === "approval"
        ? "approval"
        : status === "input"
          ? "question"
          : status === "failed" || status === "limited"
            ? "failed"
            : null;
    // A request that stays pending across runs reports once; failures report per run.
    let attention: Array<string> | null = null;
    if (attentionKind !== null) {
      const own =
        attentionKind === "question" && thread.hasPendingUserInput
          ? thread.pendingUserInputAt
          : attentionKind === "approval" && thread.hasPendingApprovals
            ? thread.pendingApprovalAt
            : null;
      const fromChildren =
        attentionKind === "failed"
          ? []
          : ((childRequests ??= childRequestsByParent(input.shells)).get(key)?.[attentionKind] ??
            []);
      const requests = [...(own == null ? [] : [own]), ...fromChildren];
      if (requests.length === 0) requests.push(thread.latestRun?.runId ?? "");
      attention = requests.map((request) => `${status}:${request}`);
    }
    const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
    const completion =
      status === "ready" && thread.latestRun?.status === "completed" && Number.isFinite(completedAt)
        ? completedAt
        : (prior?.completion ?? null);
    const ended = thread.archivedAt !== null || thread.settledOverride === "settled";
    const state = {
      environmentId: thread.environmentId,
      threadId: thread.id,
      title: thread.title,
      attention,
      completion,
      ended,
      launchSeen: fresh,
    };
    next.set(key, state);
    if (prior === undefined) {
      // A start-up watch whose thread was settled while the app was closed.
      if (ended && watch !== undefined && input.knownWatchKeys.has(key)) {
        events.push({ ...eventBase(state), kind: "ended" });
      }
      continue;
    }
    if (ended) {
      if (!prior.ended && watch !== undefined) events.push({ ...eventBase(state), kind: "ended" });
      continue;
    }
    if (
      attentionKind !== null &&
      attention !== null &&
      attention.some((request) => !prior.attention?.includes(request))
    ) {
      events.push({ ...eventBase(state), kind: attentionKind });
    } else if (
      completion !== null &&
      (prior.completion === null || completion > prior.completion) &&
      !startedByUser(thread)
    ) {
      events.push({
        ...eventBase(state),
        kind: "completed",
        ...(thread.latestRun === null ? {} : { runId: RunId.make(thread.latestRun.runId) }),
      });
    }
  }
  // Threads that are watched or tracked but missing from the shell list.
  const missing = new Set([...watches.keys(), ...input.previous.keys()]);
  for (const key of missing) {
    if (present.has(key)) continue;
    const watch = watches.get(key);
    const seen = input.previous.get(key);
    const environmentId = watch?.environmentId ?? seen?.environmentId;
    if (environmentId === undefined || (watch === undefined && !input.home.watchAll)) continue;
    if (!input.liveEnvironmentIds.has(environmentId)) {
      if (seen !== undefined) next.set(key, seen);
      continue;
    }
    // A watch added after start-up may arrive before its thread does.
    if (watch === undefined || (seen === undefined && !input.knownWatchKeys.has(key))) continue;
    const state = seen ?? {
      environmentId,
      threadId: watch.threadId,
      title: "",
      ...UNSEEN,
      launchSeen: false,
    };
    // Keep the ended state until the watch is gone, so it is reported once.
    next.set(key, { ...state, ended: true });
    if (!state.ended) events.push({ ...eventBase(state), kind: "ended" });
  }
  return { next, events };
}
