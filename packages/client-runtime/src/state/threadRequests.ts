import {
  idleCompactionOf,
  isLiveRunForShell,
  userOnlyCardWaits,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalFullAccessOverride,
  type ProviderApprovalOption,
  type ProviderApprovalDecision,
  type ProviderRequestKind,
  type RuntimeRequestId,
  type TurnItemId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { arrayElementsEqualBy, parseThreadKey, threadKey } from "./entities.ts";
import { getProjectionArrayReplacementIndex } from "./orchestrationV2Projection.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import * as DateTime from "effect/DateTime";
import type { AtomCommandResult } from "./runtime.ts";
import type {
  ThreadStructure,
  ThreadStructureTurnItem,
  ThreadStructureVisibleTurnItem,
} from "./models.ts";

export type ApprovalResponder = (
  requestId: RuntimeRequestId,
  decision: ProviderApprovalDecision,
  feedback?: string,
) => Promise<AtomCommandResult<unknown, unknown> | undefined>;

/** Feedback belongs to the displayed request, which may be a native child's tool call. */
export async function sendApprovalFeedback(
  approval: ThreadPendingApproval,
  feedback: string,
  respond: ApprovalResponder,
): Promise<boolean> {
  if (!approval.supportsFeedback || approval.responseCapability !== "live" || !feedback.trim())
    return false;
  return (await respond(approval.requestId, "decline", feedback.trim()))?._tag === "Success";
}

/** Declines every approval a redirect replaces; any one still pending would block the agent. */
export async function declinePendingApprovals(
  approvals: ReadonlyArray<ThreadPendingApproval>,
  respond: ApprovalResponder,
): Promise<boolean> {
  for (const approval of approvals) {
    // A request the provider can no longer answer has nothing to decline.
    if (approval.responseCapability !== "live") continue;
    if ((await respond(approval.requestId, "decline"))?._tag !== "Success") return false;
  }
  return true;
}

export interface ThreadPendingApproval {
  readonly requestId: RuntimeRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly createdAt: string;
  readonly detail?: string;
  readonly reason?: string;
  readonly fullAccessOverride?: ProviderApprovalFullAccessOverride;
  readonly appName?: string;
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
  readonly responseCapability: "live" | "not_resumable";
  readonly supportsFeedback?: boolean;
}

export const FULL_ACCESS_OVERRIDE_QUESTION = "Why am I being asked this?";

export function fullAccessOverrideExplanation(
  override: ProviderApprovalFullAccessOverride,
): string {
  return override === "ask_rule"
    ? "Full access skips approvals, but an ask rule in the agent's own settings matches this action, so it still asks. Remove or narrow that rule to stop these prompts."
    : "Full access skips approvals, but the agent still stops for a few safety checks of its own that no setting can skip, such as a delete whose path it can't verify. T3 Code can't turn these off, so check the request and approve it if it's what you expect.";
}

export interface ThreadUserInputQuestion extends Omit<
  OrchestrationV2UserInputQuestion,
  "multiSelect"
> {
  readonly multiSelect: boolean;
}

export interface ThreadPendingUserInput {
  readonly requestId: RuntimeRequestId;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<ThreadUserInputQuestion>;
  readonly responseCapability: OrchestrationV2RuntimeRequest["responseCapability"]["type"];
  readonly responseMode?: "message";
  readonly dismissible: boolean;
}

export interface PendingThreadRequests {
  readonly approvals: ReadonlyArray<ThreadPendingApproval>;
  readonly userInputs: ReadonlyArray<ThreadPendingUserInput>;
}

export function seedUserInputDraftAnswers<Draft extends { readonly customAnswer?: string }>(
  questions: ReadonlyArray<
    Pick<OrchestrationV2UserInputQuestion, "id" | "allowCustomAnswer" | "initialAnswer">
  >,
  drafts: Record<string, Draft>,
): Record<string, Draft | { customAnswer: string }> {
  // Entries, not assignment, so an id such as `__proto__` becomes an own draft.
  const seeds = questions.flatMap((question) =>
    question.initialAnswer === undefined ||
    question.allowCustomAnswer === false ||
    Object.hasOwn(drafts, question.id)
      ? []
      : [[question.id, { customAnswer: question.initialAnswer }] as const],
  );
  return seeds.length === 0 ? drafts : { ...drafts, ...Object.fromEntries(seeds) };
}

/** Keys a user-input draft by thread so a thread's resolved requests can be pruned together. */
export function userInputDraftKey(
  environmentId: string,
  threadId: string | null,
  requestId: string | undefined,
): string {
  return JSON.stringify([environmentId, threadId, requestId]);
}

/**
 * Drops the thread's drafts for requests outside `pendingRequestIds`, leaving
 * other threads alone. Returns the input itself when nothing is dropped.
 */
export function pruneResolvedUserInputDrafts<T>(
  draftsByRequestKey: Record<string, T>,
  environmentId: string,
  threadId: string,
  pendingRequestIds: ReadonlyArray<string>,
): Record<string, T> {
  const threadPrefix = JSON.stringify([environmentId, threadId]).slice(0, -1);
  const pendingKeys = new Set(
    pendingRequestIds.map((requestId) => userInputDraftKey(environmentId, threadId, requestId)),
  );
  const retained = Object.entries(draftsByRequestKey).filter(
    ([key]) => !key.startsWith(threadPrefix) || pendingKeys.has(key),
  );
  return retained.length === Object.keys(draftsByRequestKey).length
    ? draftsByRequestKey
    : Object.fromEntries(retained);
}

/**
 * Question attachment drafts are keyed `<thread prefix><encoded [requestId, questionId]>`.
 * Returns the keys under `threadPrefix` whose request is outside `pendingRequestIds`.
 */
export function resolvedQuestionDraftKeys(
  keys: Iterable<string>,
  threadPrefix: string,
  pendingRequestIds: ReadonlyArray<string>,
): string[] {
  // encodeURIComponent is per character, so an encoded JSON prefix prefixes the encoded key.
  const pendingPrefixes = pendingRequestIds.map(
    (requestId) =>
      `${threadPrefix}${encodeURIComponent(`${JSON.stringify([requestId]).slice(0, -1)},`)}`,
  );
  const resolved: string[] = [];
  for (const key of keys) {
    if (key.startsWith(threadPrefix) && !pendingPrefixes.some((prefix) => key.startsWith(prefix)))
      resolved.push(key);
  }
  return resolved;
}

export interface ThreadRequestsResolved {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Every request the thread still waits on; drafts for any other request are stale. */
  readonly pendingRequestIds: ReadonlyArray<RuntimeRequestId>;
  /** Requests that closed without an answer (cancelled or expired), so typed drafts were never sent. */
  readonly unansweredRequestIds: ReadonlyArray<RuntimeRequestId>;
}

const threadRequestsResolvedListeners = new Set<(event: ThreadRequestsResolved) => void>();

/**
 * Clients register draft pruners once at module level. Thread state announces
 * when its synchronized projection first lands and whenever a request leaves
 * pending, wherever the resolution came from (another device, interrupt, turn end).
 */
export function onThreadRequestsResolved(
  listener: (event: ThreadRequestsResolved) => void,
): () => void {
  threadRequestsResolvedListeners.add(listener);
  return () => threadRequestsResolvedListeners.delete(listener);
}

function notifyThreadRequestsResolved(event: ThreadRequestsResolved): void {
  for (const listener of threadRequestsResolvedListeners) {
    try {
      listener(event);
    } catch (error) {
      // A failing pruner must neither stop the others nor break thread sync.
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}

/**
 * Tracks one thread's announced pending requests. Feed it the runtime requests
 * of each authoritative projection; it notifies on the first one and whenever an
 * announced request is no longer pending. New requests alone stay quiet.
 */
export function makeThreadRequestsResolvedAnnouncer(
  environmentId: EnvironmentId,
  threadId: ThreadId,
) {
  let announced: ReadonlySet<RuntimeRequestId> | null = null;
  return (
    runtimeRequests: ReadonlyArray<
      Pick<OrchestrationV2ThreadProjection["runtimeRequests"][number], "id" | "status">
    >,
  ) => {
    const pendingRequestIds = runtimeRequests.flatMap((request) =>
      request.status === "pending" ? [request.id] : [],
    );
    const pending = new Set(pendingRequestIds);
    const resolvedSome = announced === null || [...announced].some((id) => !pending.has(id));
    announced = pending;
    if (!resolvedSome) return;
    const unansweredRequestIds = runtimeRequests.flatMap((request) =>
      request.status === "cancelled" || request.status === "expired" ? [request.id] : [],
    );
    notifyThreadRequestsResolved({
      environmentId,
      threadId,
      pendingRequestIds,
      unansweredRequestIds,
    });
  };
}

export function derivePendingThreadRequests(
  projection: Pick<ThreadStructure, "runtimeRequests" | "turnItems">,
): PendingThreadRequests {
  const approvals: ThreadPendingApproval[] = [];
  const userInputs: ThreadPendingUserInput[] = [];

  for (const request of projection.runtimeRequests) {
    if (request.status !== "pending") continue;
    const responseCapability = request.responseCapability.type;
    if (request.kind === "user_input") {
      const item = projection.turnItems.findLast(
        (candidate) =>
          candidate.type === "user_input_request" && candidate.requestId === request.id,
      );
      if (item === undefined || item.type !== "user_input_request") continue;
      userInputs.push({
        requestId: request.id,
        createdAt: DateTime.formatIso(request.createdAt),
        questions: item.questions.map((question) => ({
          ...question,
          multiSelect: question.multiSelect ?? false,
        })),
        responseCapability,
        dismissible: item.responseMode === "message" || responseCapability === "message",
        ...(item.responseMode === "message" || responseCapability === "message"
          ? { responseMode: "message" as const }
          : {}),
      });
      continue;
    }

    if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") continue;
    const item = projection.turnItems.findLast(
      (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id,
    );
    approvals.push({
      requestId: request.id,
      requestKind: request.kind,
      createdAt: DateTime.formatIso(request.createdAt),
      ...(item?.type === "approval_request" && item.prompt ? { detail: item.prompt } : {}),
      ...(item?.type === "approval_request" && item.reason ? { reason: item.reason } : {}),
      ...(item?.type === "approval_request" && item.fullAccessOverride
        ? { fullAccessOverride: item.fullAccessOverride }
        : {}),
      ...(item?.type === "approval_request" && item.appName ? { appName: item.appName } : {}),
      ...(item?.type === "approval_request" && item.options !== undefined
        ? { options: item.options }
        : {}),
      responseCapability: responseCapability === "live" ? "live" : "not_resumable",
      ...(request.responseCapability.type === "live" && request.responseCapability.supportsFeedback
        ? { supportsFeedback: true }
        : {}),
    });
  }

  return { approvals, userInputs };
}

export function createQuestionHistoryProjector<
  Row extends ThreadStructureVisibleTurnItem =
    OrchestrationV2ThreadProjection["visibleTurnItems"][number],
>() {
  type Rows = ReadonlyArray<Row>;
  type Requests = OrchestrationV2ThreadProjection["runtimeRequests"];
  let previousRows: Rows | undefined;
  let previousRequests: Requests | undefined;
  let previousResult: Rows | undefined;
  let byId = new Map<RuntimeRequestId, Requests[number]>();
  const cache = new WeakMap<Row, { request: Requests[number]; row: Row }>();
  const projectRow = (row: Row): Row => {
    const item = row.item;
    if (item.type !== "user_input_request" || item.questionAnswer) return row;
    const request = byId.get(item.requestId);
    if (request?.status !== "resolved" || request.answers === undefined) return row;
    const cached = cache.get(row);
    const next: Row =
      cached?.request === request
        ? cached.row
        : {
            ...row,
            item: {
              ...item,
              questionAnswer: {
                requestId: request.id,
                answers: request.answers,
                attachmentsByQuestionId: {},
                questionTextById: Object.fromEntries(
                  item.questions.map((question) => [question.id, question.question]),
                ),
              },
            },
          };
    cache.set(row, { request, row: next });
    return next;
  };
  const projectRows = (rows: Rows): Rows => {
    let result: Row[] | undefined;
    for (const [index, row] of rows.entries()) {
      const next = projectRow(row);
      if (next !== row) result ??= rows.slice(0, index);
      result?.push(next);
    }
    return result ?? rows;
  };
  return (projection: {
    readonly visibleTurnItems: Rows;
    readonly runtimeRequests: Requests;
  }): Rows => {
    const { visibleTurnItems: rows, runtimeRequests: requests } = projection;
    const sameRequests = requests === previousRequests;
    if (rows === previousRows && sameRequests && previousResult) return previousResult;
    if (!sameRequests) byId = new Map(requests.map((request) => [request.id, request]));
    // Nothing was overlaid and requests are unchanged, so only an exactly replaced row can differ.
    const replacedIndex =
      sameRequests && previousRows !== undefined && previousResult === previousRows
        ? getProjectionArrayReplacementIndex(previousRows, rows)
        : undefined;
    const unchanged =
      replacedIndex !== undefined && projectRow(rows[replacedIndex]!) === rows[replacedIndex];
    previousRows = rows;
    previousRequests = requests;
    previousResult = unchanged ? rows : projectRows(rows);
    return previousResult;
  };
}

export interface ThreadPendingUserOnlyRequest {
  readonly itemId: TurnItemId;
  readonly createdAt: string;
  readonly label: string | null;
}

/** Secret and link cards still waiting, by the rule the server's shell uses. */
export function derivePendingUserOnlyRequests(projection: {
  readonly turnItems: ThreadStructure["turnItems"];
  readonly runs: ReadonlyArray<
    Pick<ThreadStructure["runs"][number], "id" | "status" | "userMessageId">
  >;
  readonly messages: ReadonlyArray<
    Pick<
      ThreadStructure["messages"][number],
      "id" | "role" | "text" | "createdBy" | "creationSource" | "idleCompaction" | "updatedAt"
    >
  >;
}): ReadonlyArray<ThreadPendingUserOnlyRequest> {
  const candidates = projection.turnItems.filter(
    (item): item is Extract<ThreadStructureTurnItem, { type: "secret_request" | "link_request" }> =>
      (item.type === "secret_request" || item.type === "link_request") && item.status === "waiting",
  );
  if (candidates.length === 0) return [];
  const liveRunIds = new Set(
    projection.runs.flatMap((run) => (isLiveRunForShell(run, projection) ? [run.id] : [])),
  );
  let latestUserMessageAt: DateTime.Utc | null = null;
  for (const message of projection.messages) {
    if (message.role !== "user" || idleCompactionOf(message) !== undefined) continue;
    if (
      latestUserMessageAt === null ||
      DateTime.isGreaterThan(message.updatedAt, latestUserMessageAt)
    )
      latestUserMessageAt = message.updatedAt;
  }
  return candidates.flatMap((item) =>
    userOnlyCardWaits(item, liveRunIds, latestUserMessageAt)
      ? [
          {
            itemId: item.id,
            createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
            label: item.label ?? null,
          },
        ]
      : [],
  );
}

export interface ChildThreadApproval {
  readonly thread: ScopedThreadRef;
  readonly title: string;
  readonly approval: ThreadPendingApproval;
}

export function createChildThreadApprovalsAtom(input: {
  readonly childThreadInputsAtom: (
    ref: ScopedThreadRef,
  ) => Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>;
  readonly pendingRequestsAtom: (ref: ScopedThreadRef) => Atom.Atom<PendingThreadRequests | null>;
}) {
  const family = Atom.family((key: string) => {
    let previous: ReadonlyArray<ChildThreadApproval> = [];
    return Atom.make((get) => {
      const next = get(input.childThreadInputsAtom(parseThreadKey(key))).flatMap((child) => {
        if (!child.hasPendingApprovals) return [];
        const thread = { environmentId: child.environmentId, threadId: child.id };
        // Only children asking for approval need a detail subscription.
        return (get(input.pendingRequestsAtom(thread))?.approvals ?? []).map((approval) => ({
          thread,
          title: child.title,
          approval,
        }));
      });
      if (
        next.length === previous.length &&
        next.every((entry, index) => {
          const old = previous[index]!;
          return (
            old.approval === entry.approval &&
            old.title === entry.title &&
            threadKey(old.thread) === threadKey(entry.thread)
          );
        })
      )
        return previous;
      previous = next;
      return next;
    });
  });
  const empty = Atom.make<ReadonlyArray<ChildThreadApproval>>([]);
  return (ref: ScopedThreadRef | null) => (ref === null ? empty : family(threadKey(ref)));
}

interface OpenDecisionBase {
  readonly thread: ScopedThreadRef;
  readonly title: string;
  readonly createdAt: string;
}

export type OpenDecision =
  | (OpenDecisionBase & { readonly kind: "approval"; readonly approval: ThreadPendingApproval })
  | (OpenDecisionBase & { readonly kind: "question"; readonly userInput: ThreadPendingUserInput })
  | (OpenDecisionBase & {
      readonly kind: "userOnly";
      readonly request: ThreadPendingUserOnlyRequest;
    });

const decisionRequestId = (decision: OpenDecision) =>
  decision.kind === "approval"
    ? decision.approval.requestId
    : decision.kind === "question"
      ? decision.userInput.requestId
      : decision.request.itemId;

const decisionRequest = (decision: OpenDecision) =>
  decision.kind === "approval"
    ? decision.approval
    : decision.kind === "question"
      ? decision.userInput
      : decision.request;

export function openDecisionKey(decision: OpenDecision): string {
  return JSON.stringify([threadKey(decision.thread), decision.kind, decisionRequestId(decision)]);
}

type AskingThread = Pick<EnvironmentThreadShell, "environmentId" | "id" | "title">;

const sameAskingThread = (left: AskingThread, right: AskingThread) =>
  left.environmentId === right.environmentId && left.id === right.id && left.title === right.title;

const sameDecision = (left: OpenDecision, right: OpenDecision) =>
  left.kind === right.kind &&
  left.title === right.title &&
  left.createdAt === right.createdAt &&
  threadKey(left.thread) === threadKey(right.thread) &&
  decisionRequest(left) === decisionRequest(right);

export function createOpenDecisionsAtoms(input: {
  readonly threadShellsAtom: Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>;
  readonly pendingRequestsAtom: (ref: ScopedThreadRef) => Atom.Atom<PendingThreadRequests | null>;
  readonly pendingUserOnlyRequestsAtom: (
    ref: ScopedThreadRef,
  ) => Atom.Atom<ReadonlyArray<ThreadPendingUserOnlyRequest>>;
}) {
  let previousAsking: ReadonlyArray<AskingThread> = [];
  const askingThreadsAtom = Atom.make((get) => {
    const next = get(input.threadShellsAtom).filter(
      (shell) => shell.hasPendingApprovals || shell.hasPendingUserInput,
    );
    if (arrayElementsEqualBy(next, previousAsking, sameAskingThread)) return previousAsking;
    previousAsking = next;
    return previousAsking;
  }).pipe(Atom.withLabel("open-decision-threads"));

  let previous: ReadonlyArray<OpenDecision> = [];
  const decisionsAtom = Atom.make((get) => {
    const next: OpenDecision[] = [];
    for (const shell of get(askingThreadsAtom)) {
      const base = {
        thread: { environmentId: shell.environmentId, threadId: shell.id },
        title: shell.title,
      };
      for (const request of get(input.pendingUserOnlyRequestsAtom(base.thread)))
        next.push({ ...base, kind: "userOnly", createdAt: request.createdAt, request });
      const requests = get(input.pendingRequestsAtom(base.thread));
      for (const approval of requests?.approvals ?? [])
        next.push({ ...base, kind: "approval", createdAt: approval.createdAt, approval });
      for (const userInput of requests?.userInputs ?? [])
        next.push({ ...base, kind: "question", createdAt: userInput.createdAt, userInput });
    }
    next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    if (arrayElementsEqualBy(next, previous, sameDecision)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel("open-decisions"));

  const askingThreadCountAtom = Atom.make((get) => get(askingThreadsAtom).length).pipe(
    Atom.withLabel("open-decision-thread-count"),
  );
  return { decisionsAtom, askingThreadCountAtom };
}
