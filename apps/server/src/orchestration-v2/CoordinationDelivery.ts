import {
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  RunId,
} from "@t3tools/contracts";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import * as Schema from "effect/Schema";

export class CoordinationResultDeferred extends Schema.TaggedError<CoordinationResultDeferred>()(
  "CoordinationResultDeferred",
  { sourceRunId: RunId },
) {}

/**
 * A restart cuts a run and continues it as a new run. The cut run's inputs belong to
 * the chain; the continuation prompts the server wrote do not.
 */
export function restartChain(
  runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "id" | "userMessageId" | "restartContinuationOfRunId">
  >,
  runId: RunId,
) {
  const runIds: Array<RunId> = [runId];
  const continuationMessageIds = new Set<MessageId>();
  let current = runs.find((run) => run.id === runId);
  while (current?.restartContinuationOfRunId !== undefined) {
    const previousRunId: RunId = current.restartContinuationOfRunId;
    if (runIds.includes(previousRunId)) break;
    continuationMessageIds.add(current.userMessageId);
    runIds.push(previousRunId);
    current = runs.find((run) => run.id === previousRunId);
  }
  return { runIds, continuationMessageIds };
}

type Message = Pick<OrchestrationV2ConversationMessage, "id" | "coordination">;
/** Turn item types that record tool work; a completed one after a send makes the send mid-job. */
export const coordinationToolItemTypes = [
  "command_execution",
  "dynamic_tool",
  "file_change",
  "file_search",
  "subagent",
  "web_search",
] as const satisfies ReadonlyArray<OrchestrationV2TurnItem["type"]>;

type ToolItem = Pick<OrchestrationV2TurnItem, "type" | "status" | "ordinal"> & {
  readonly toolName?: string | null;
  readonly input?: unknown;
};

/**
 * The requester the run chain's final tool work messaged with a completed `t3_thread_send`, as
 * `{ threadId, environmentId? }`. A send followed by any other completed tool item was a mid-job
 * message, so it answers nobody. Items are ordered by their projection ordinal.
 */
function finalSendTarget(toolItems: ReadonlyArray<ToolItem>) {
  const last = toolItems
    .filter(({ status }) => status === "completed")
    .reduce<ToolItem | undefined>(
      (latest, item) => (latest === undefined || item.ordinal >= latest.ordinal ? item : latest),
      undefined,
    );
  if (last?.type !== "dynamic_tool" || resolveT3McpToolId(last.toolName) !== "t3_thread_send") {
    return undefined;
  }
  if (typeof last.input !== "object" || last.input === null) return undefined;
  return last.input as { readonly threadId?: unknown; readonly environmentId?: unknown };
}

/**
 * A send that names no environment acts in the run's own; its thread id stands for the
 * requester there.
 */
function isRequester(
  target: { readonly threadId?: unknown; readonly environmentId?: unknown } | undefined,
  requester: { readonly environmentId: string; readonly threadId: string },
) {
  return (
    target !== undefined &&
    target.threadId === requester.threadId &&
    (target.environmentId === undefined || target.environmentId === requester.environmentId)
  );
}

/**
 * One result per requester: a run that took in several requests from the same thread answers
 * them together, so the requester receives that answer once, for its latest request. A
 * requester whose `t3_thread_send` was the run chain's last completed tool work has its answer and
 * gets none.
 */
export function requestResults(input: {
  readonly messages: ReadonlyArray<Message>;
  readonly sourceRunId: RunId;
  readonly text: string;
  /** The run chain's tool items; the last completed one decides whether a send was the answer. */
  readonly toolItems: ReadonlyArray<ToolItem>;
}) {
  const latestByRequester = new Map<
    string,
    {
      readonly requester: NonNullable<
        Extract<Message["coordination"], { kind: "request" }>
      >["requester"];
      readonly requestMessageId: Message["id"];
    }
  >();
  for (const message of input.messages) {
    if (message.coordination?.kind !== "request") continue;
    const { requester } = message.coordination;
    latestByRequester.set(JSON.stringify([requester.environmentId, requester.threadId]), {
      requester,
      requestMessageId: message.id,
    });
  }
  const answered = finalSendTarget(input.toolItems);
  return [...latestByRequester.values()]
    .filter(({ requester }) => !isRequester(answered, requester))
    .map(({ requester, requestMessageId }) => ({
      requester,
      requestMessageId,
      sourceRunId: input.sourceRunId,
      text: input.text,
    }));
}

export function isCoordinationRun(
  messages: ReadonlyArray<Pick<OrchestrationV2ConversationMessage, "role" | "coordination">>,
) {
  const inputs = messages.filter((message) => message.role === "user");
  return (
    inputs.length > 0 &&
    inputs.every(
      (message) =>
        message.coordination?.kind === "request" ||
        (message.coordination?.kind === "response" &&
          message.coordination.owner === "coordination"),
    )
  );
}
