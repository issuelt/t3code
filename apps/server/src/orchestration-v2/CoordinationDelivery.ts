import type {
  MessageId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  RunId,
} from "@t3tools/contracts";
import * as Data from "effect/Data";

export class CoordinationResultDeferred extends Data.TaggedError("CoordinationResultDeferred")<{
  readonly sourceRunId: RunId;
}> {}

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

export function requestResults(input: {
  readonly messages: ReadonlyArray<Message>;
  readonly sourceRunId: RunId;
  readonly text: string;
}) {
  return input.messages.flatMap((message) =>
    message.coordination?.kind === "request"
      ? [
          {
            requester: message.coordination.requester,
            requestMessageId: message.id,
            sourceRunId: input.sourceRunId,
            text: input.text,
          },
        ]
      : [],
  );
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
