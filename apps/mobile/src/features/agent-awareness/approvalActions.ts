import {
  EnvironmentId,
  type ProviderApprovalDecision,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { RelayApprovalNotificationAction, RelayPendingApproval } from "@t3tools/contracts/relay";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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
          threadId: pendingApproval.requestThreadId,
          requestId: pendingApproval.requestId,
          decision: APPROVAL_ACTIONS[actionIdentifier].decision,
        } satisfies ApprovalAnswer,
      };
    },
  });
}

export function unreachableText(environmentLabel: string | null): string {
  return `Couldn't reach ${environmentLabel ?? "this environment"}`;
}
