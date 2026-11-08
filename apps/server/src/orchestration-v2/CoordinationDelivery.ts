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
type ToolItem = Pick<OrchestrationV2TurnItem, "type" | "status"> & {
  readonly toolName?: string | null;
  readonly input?: unknown;
};

/**
 * Whether the run chain reached the requester with a completed `t3_thread_send`. A send that
 * names no environment acts in the run's own; its thread id stands for the requester there.
 */
function messagedRequester(
  toolItems: ReadonlyArray<ToolItem>,
  requester: { readonly environmentId: string; readonly threadId: string },
) {
  return toolItems.some(({ type, status, toolName, input }) => {
    if (type !== "dynamic_tool" || status !== "completed") return false;
    if (resolveT3McpToolId(toolName) !== "t3_thread_send") return false;
    if (typeof input !== "object" || input === null) return false;
    const target = input as { readonly threadId?: unknown; readonly environmentId?: unknown };
    return (
      target.threadId === requester.threadId &&
      (target.environmentId === undefined || target.environmentId === requester.environmentId)
    );
  });
}

/**
 * One result per requester: a run that took in several requests from the same thread answers
 * them together, so the requester receives that answer once, for its latest request. A
 * requester the run chain already messaged with `t3_thread_send` has its answer and gets none.
 */
export function requestResults(input: {
  readonly messages: ReadonlyArray<Message>;
  readonly sourceRunId: RunId;
  readonly text: string;
  /** The run chain's turn items; only completed `t3_thread_send` calls count. */
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
  return [...latestByRequester.values()]
    .filter(({ requester }) => !messagedRequester(input.toolItems, requester))
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
