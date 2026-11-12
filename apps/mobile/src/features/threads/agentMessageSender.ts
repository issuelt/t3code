import type { EnvironmentId, OrchestrationV2ConversationMessage } from "@t3tools/contracts";

/** The thread an agent-delivered message came from, here or in a linked environment. */
export function agentMessageSender(
  message: Pick<
    OrchestrationV2ConversationMessage,
    "linkedSender" | "senderThreadId" | "coordination"
  >,
  environmentId: EnvironmentId,
) {
  if (message.linkedSender !== undefined) {
    return {
      environmentId: message.linkedSender.environmentId,
      threadId: message.linkedSender.threadId,
      linked: true,
    };
  }
  const threadId =
    message.senderThreadId ??
    (message.coordination?.kind === "request"
      ? message.coordination.requester.threadId
      : undefined);
  return threadId === undefined ? null : { environmentId, threadId, linked: false };
}
