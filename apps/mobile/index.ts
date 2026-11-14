// Must stay first: the render counter and behavior probe wrap the DevTools hook before any React commit.
import "./src/features/development/render-counter-entry";
import "./src/features/development/behavior-probe-entry";
// Next, so errors thrown while the rest of the app loads are recorded too.
import "./src/features/observability/observe";
import { registerRootComponent, requireOptionalNativeModule } from "expo";
import "react-native-gesture-handler";
import { AppRegistry, LogBox } from "react-native";
import { featureFlags } from "react-native-screens";

import App from "./src/App";

// Enables iOS FormSheet sizing for nested native stacks in non-fitToContents sheets.
featureFlags.experiment.synchronousScreenUpdatesEnabled = true;

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  LogBox.ignoreAllLogs();
}

registerRootComponent(App);
AppRegistry.registerHeadlessTask("T3ApprovalAction", () => async (data: unknown) => {
  const notifications = requireOptionalNativeModule<{
    finishApprovalAction(id: number): void;
  }>("T3AgentNotifications");
  console.log("[approval-prototype] headless task started", JSON.stringify(data));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const id = Number((data as { notificationId: number }).notificationId);
  notifications?.finishApprovalAction(id);
  console.log("[approval-prototype] headless task finished", id);
});
