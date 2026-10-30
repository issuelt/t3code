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

/**
 * One result per requester: a run that took in several requests from the same thread answers
 * them together, so the requester receives that answer once, for its latest request.
 */
export function requestResults(input: {
  readonly messages: ReadonlyArray<Message>;
  readonly sourceRunId: RunId;
  readonly text: string;
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
  return [...latestByRequester.values()].map(({ requester, requestMessageId }) => ({
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
