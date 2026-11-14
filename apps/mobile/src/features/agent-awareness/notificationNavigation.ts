import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { setAndroidThreadOnScreen } from "./androidNotifications";
import { iosApprovalResponse } from "./approvalActions";
import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";
import { routeAgentNotificationResponseOnce, threadDeepLinkOnScreen } from "./notificationPayload";
import { handleIosApprovalResponse, registerIosApprovalCategory } from "./iosApprovalActions";
import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

let deepLinkOnScreen: string | null = null;

/** Called with the workspace pathname on every root navigation state change. */
export function setAgentNotificationPathname(pathname: string): void {
  deepLinkOnScreen = threadDeepLinkOnScreen(pathname);
  setAndroidThreadOnScreen(deepLinkOnScreen);
}

/**
 * App-lifetime notification routing: foreground presentation suppresses the
 * thread already on screen, and taps (including the cold-start tap) open the
 * notification's deep link through `navigate`.
 */
export function installAgentNotificationNavigation(navigate: (href: string) => void): () => void {
  const handledResponseIds = new Set<string>();
  Notifications.setNotificationHandler({
    handleNotification: (notification) =>
      Promise.resolve(foregroundNotificationBehavior(notification, deepLinkOnScreen)),
  });

  if (Platform.OS === "ios") {
    void registerIosApprovalCategory().catch((cause: unknown) =>
      console.error("[approval-actions] could not register the approval actions", cause),
    );
  }
  const handleResponse = (response: Notifications.NotificationResponse): void => {
    const approval = Platform.OS === "ios" ? iosApprovalResponse(response) : null;
    if (approval !== null) {
      // The cold-start read and the listener can both deliver the same action.
      const key = `${approval.notificationIdentifier}\n${approval.actionIdentifier}`;
      if (!handledResponseIds.has(key)) {
        handledResponseIds.add(key);
        void handleIosApprovalResponse(approval);
      }
      return;
    }
    routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate });
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
  void consumeLastAgentNotificationResponse({
    getLastResponse: () => Notifications.getLastNotificationResponseAsync(),
    clearLastResponse: () => Notifications.clearLastNotificationResponseAsync(),
    handleResponse,
  });

  return () => {
    subscription.remove();
    Notifications.setNotificationHandler(null);
  };
}
