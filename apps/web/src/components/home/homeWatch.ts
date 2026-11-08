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
  readonly attention: string | null;
  readonly completion: number | null;
  readonly ended: boolean;
  /** Set once a launch watch added after start-up has been compared with an empty state. */
  readonly launchSeen: boolean;
}

export const homeWatchKey = (environmentId: string, threadId: string) =>
  `${environmentId}\u0000${threadId}`;

const UNSEEN = { attention: null, completion: null, ended: false };

/**
 * Each thread's newest approval request among its subagent and side-chat
 * children, keyed by `homeWatchKey`, so a child's approval that rolls up to its
 * parent keeps one identity across the parent's runs.
 */
function childApprovalsByParent(shells: ReadonlyArray<EnvironmentThreadShell>) {
  const byKey = new Map(
    shells.map((shell) => [homeWatchKey(shell.environmentId, shell.id), shell]),
  );
  const approvals = new Map<string, { readonly request: string; readonly at: string }>();
  for (const child of shells) {
    const at = child.pendingApprovalAt;
    if (at == null) continue;
    let current = child;
    const seen = new Set<string>();
    while (
      current.lineage.relationshipToParent === "subagent" ||
      current.lineage.sideChat === true
    ) {
      const parentId = current.lineage.parentThreadId;
      if (parentId === null) break;
      const key = homeWatchKey(current.environmentId, parentId);
      if (seen.has(key)) break;
      seen.add(key);
      const known = approvals.get(key);
      if (known === undefined || known.at < at)
        approvals.set(key, { request: `${child.id}@${at}`, at });
      const parent = byKey.get(key);
      if (parent === undefined) break;
      current = parent;
    }
  }
  return approvals;
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
  let childApprovals: ReturnType<typeof childApprovalsByParent> | undefined;
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
    const request =
      attentionKind === "question"
        ? thread.pendingUserInputAt
        : attentionKind === "approval"
          ? thread.hasPendingApprovals
            ? thread.pendingApprovalAt
            : (childApprovals ??= childApprovalsByParent(input.shells)).get(key)?.request
          : undefined;
    const attention =
      attentionKind === null
        ? null
        : `${request == null ? (thread.latestRun?.runId ?? "") : request}:${status}`;
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
    if (attentionKind !== null && attention !== prior.attention) {
      events.push({ ...eventBase(state), kind: attentionKind });
    } else if (
      completion !== null &&
      (prior.completion === null || completion > prior.completion)
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
