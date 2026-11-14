import {
  EnvironmentId,
  type ProviderApprovalDecision,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { RelayApprovalNotificationAction, RelayPendingApproval } from "@t3tools/contracts/relay";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Labels match the default options on `PendingApprovalCard` and the native Android alert. */
export const APPROVAL_ACTIONS = {
  "t3.approval.accept": { decision: "accept", label: "Allow once" },
  "t3.approval.decline": { decision: "decline", label: "Decline" },
} as const satisfies Record<
  RelayApprovalNotificationAction,
  { readonly decision: ProviderApprovalDecision; readonly label: string }
>;

export interface ApprovalAnswer {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly decision: ProviderApprovalDecision;
}

/** The extras `AgentApprovalActionReceiver` passes to the `T3ApprovalAction` headless task. */
const AndroidApprovalTask = Schema.Struct({
  actionIdentifier: RelayApprovalNotificationAction,
  notificationId: Schema.Int,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  requestId: RuntimeRequestId,
});

/** The relay puts these IDs in an approval push's `body`, which Expo reads as `data`. */
export const ApprovalNotificationData = Schema.Struct({
  environmentId: EnvironmentId,
  pendingApproval: RelayPendingApproval,
});
export type ApprovalNotificationData = typeof ApprovalNotificationData.Type;

const IosApprovalResponse = Schema.Struct({
  actionIdentifier: RelayApprovalNotificationAction,
  notification: Schema.Struct({
    request: Schema.Struct({
      identifier: Schema.String,
      content: Schema.Struct({
        title: Schema.NullOr(Schema.String),
        data: ApprovalNotificationData,
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

/** Null for a tap on the notification itself or on another category's action. */
export function iosApprovalResponse(response: unknown) {
  return Option.match(decodeIosResponse(response), {
    onNone: () => null,
    onSome: ({ actionIdentifier, notification }) => {
      const { title, data } = notification.request.content;
      const { environmentId, pendingApproval } = data;
      return {
        notificationIdentifier: notification.request.identifier,
        actionIdentifier,
        title,
        data,
        answer: {
          environmentId,
          threadId: pendingApproval.threadId,
          requestId: pendingApproval.requestId,
          decision: APPROVAL_ACTIONS[actionIdentifier].decision,
        } satisfies ApprovalAnswer,
      };
    },
  });
}

/** The text an alert shows when its environment did not answer. */
export function unreachableText(environmentLabel: string | null): string {
  return `Couldn't reach ${environmentLabel ?? "this environment"}`;
}
