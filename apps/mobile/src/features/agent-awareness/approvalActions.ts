import {
  EnvironmentId,
  type ProviderApprovalDecision,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import {
  RELAY_APPROVAL_NOTIFICATION_CATEGORY,
  RelayApprovalNotificationAction,
  RelayPendingApproval,
} from "@t3tools/contracts/relay";
import type { NotificationContentInput } from "expo-notifications";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { RuntimeRequestAnswerOutcome } from "@t3tools/client-runtime/state/runtime-request-http";

export const APPROVAL_ACTIONS = {
  "t3.approval.accept": { decision: "accept", label: "Allow once", progress: "Allowing…" },
  "t3.approval.decline": { decision: "decline", label: "Decline", progress: "Declining…" },
} as const satisfies Record<
  RelayApprovalNotificationAction,
  {
    readonly decision: ProviderApprovalDecision;
    readonly label: string;
    readonly progress: string;
  }
>;

export interface ApprovalAnswer {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly decision: ProviderApprovalDecision;
}

const AndroidApprovalTask = Schema.Struct({
  actionIdentifier: RelayApprovalNotificationAction,
  notificationId: Schema.Int,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  requestId: RuntimeRequestId,
});

/** The relay puts these IDs in an approval push's `body`, which Expo reads as `data`. */
const ApprovalNotificationData = Schema.Struct({
  environmentId: EnvironmentId,
  pendingApproval: RelayPendingApproval,
});

const IosApprovalResponse = Schema.Struct({
  actionIdentifier: RelayApprovalNotificationAction,
  notification: Schema.Struct({
    request: Schema.Struct({
      identifier: Schema.String,
      content: Schema.Struct({
        title: Schema.NullOr(Schema.String),
        threadIdentifier: Schema.optional(Schema.NullOr(Schema.String)),
        // Kept whole, so a repost keeps the deep link and everything else the push carried.
        data: Schema.Record(Schema.String, Schema.Unknown),
      }),
    }),
  }),
});

const decodeAndroidTask = Schema.decodeUnknownOption(AndroidApprovalTask);
const decodeIosResponse = Schema.decodeUnknownOption(IosApprovalResponse);
export const decodeApprovalNotificationData = Schema.decodeUnknownOption(ApprovalNotificationData);

export function androidApprovalTask(data: unknown) {
  return Option.match(decodeAndroidTask(data), {
    onNone: () => null,
    onSome: (task) => ({
      notificationId: task.notificationId,
      answer: {
        environmentId: task.environmentId,
        threadId: task.threadId,
        requestId: task.requestId,
        decision: APPROVAL_ACTIONS[task.actionIdentifier].decision,
      } satisfies ApprovalAnswer,
    }),
  });
}

/** Null for a tap on the notification itself, another category's action, or a push without ids. */
export function iosApprovalResponse(response: unknown) {
  return Option.flatMap(decodeIosResponse(response), ({ actionIdentifier, notification }) =>
    Option.map(
      decodeApprovalNotificationData(notification.request.content.data),
      ({ environmentId, pendingApproval }) => ({
        notificationIdentifier: notification.request.identifier,
        actionIdentifier,
        content: notification.request.content,
        answer: {
          environmentId,
          threadId: pendingApproval.requestThreadId,
          requestId: pendingApproval.requestId,
          decision: APPROVAL_ACTIONS[actionIdentifier].decision,
        } satisfies ApprovalAnswer,
      }),
    ),
  ).pipe(Option.getOrNull);
}

/** What the alert says after an answer that did not go through. */
export function approvalOutcomeText(outcome: RuntimeRequestAnswerOutcome): string | null {
  switch (outcome._tag) {
    case "Answered":
      return null;
    case "Rejected":
      return outcome.reason === "not_permitted"
        ? "This connection cannot respond to approvals."
        : "This approval can no longer be answered.";
    case "Unreachable":
      return `Couldn't reach ${outcome.environmentLabel ?? "this environment"}`;
  }
}

/** Shown when an answer stopped before it reported back, such as the app being closed. */
export const APPROVAL_INTERRUPTED_TEXT = "Couldn't send your answer. Try again.";

/**
 * The iOS alert to show again after an answer that did not go through, built from the original
 * content so its deep link and thread grouping stay. Only an unreachable answer keeps its actions.
 */
export function iosApprovalRepost(
  approval: NonNullable<ReturnType<typeof iosApprovalResponse>>,
  outcome: RuntimeRequestAnswerOutcome,
): NotificationContentInput | null {
  const body = approvalOutcomeText(outcome);
  if (body === null) return null;
  const { title, threadIdentifier, data } = approval.content;
  return {
    ...(title === null ? {} : { title }),
    body,
    data,
    ...(threadIdentifier == null ? {} : { threadIdentifier }),
    ...(outcome._tag === "Unreachable"
      ? { categoryIdentifier: RELAY_APPROVAL_NOTIFICATION_CATEGORY }
      : {}),
  };
}
