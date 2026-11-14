import { RELAY_APPROVAL_NOTIFICATION_CATEGORY } from "@t3tools/contracts/relay";
import { requireOptionalNativeModule } from "expo";
import * as Notifications from "expo-notifications";

import { APPROVAL_ACTIONS, type iosApprovalResponse, unreachableText } from "./approvalActions";
import { answerApproval } from "./approvalAnswers";

/** Added to expo-notifications by the fork's patch: ends the background time iOS gave the action. */
const emitter = requireOptionalNativeModule<{
  acknowledgeNotificationResponse(notificationIdentifier: string, actionIdentifier: string): void;
}>("ExpoNotificationsEmitter");

// Deny needs authentication too: the DPoP key is readable only while the device is unlocked.
const actionOptions = { opensAppToForeground: false, isAuthenticationRequired: true };

export function registerIosApprovalCategory(): Promise<unknown> {
  return Notifications.setNotificationCategoryAsync(
    RELAY_APPROVAL_NOTIFICATION_CATEGORY,
    Object.entries(APPROVAL_ACTIONS).map(([identifier, { decision, label }]) => ({
      identifier,
      buttonTitle: label,
      options: { ...actionOptions, isDestructive: decision === "decline" },
    })),
  );
}

/**
 * Answers an approval from its notification action. When the environment does not answer, the
 * alert comes back with its actions so the user can try again.
 */
export async function handleIosApprovalResponse(
  approval: NonNullable<ReturnType<typeof iosApprovalResponse>>,
): Promise<void> {
  try {
    const outcome = await answerApproval(approval.answer);
    if (outcome._tag === "Answered") {
      await Notifications.dismissNotificationAsync(approval.notificationIdentifier);
    } else {
      await Notifications.scheduleNotificationAsync({
        identifier: approval.notificationIdentifier,
        content: {
          ...(approval.title === null ? {} : { title: approval.title }),
          body: unreachableText(outcome.environmentLabel),
          data: approval.data,
          categoryIdentifier: RELAY_APPROVAL_NOTIFICATION_CATEGORY,
        },
        trigger: null,
      });
    }
  } finally {
    emitter?.acknowledgeNotificationResponse(
      approval.notificationIdentifier,
      approval.actionIdentifier,
    );
  }
}
