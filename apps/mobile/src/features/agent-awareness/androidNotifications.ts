import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo";
import { Linking, Platform } from "react-native";

import { APPROVAL_ACTIONS } from "./approvalActions";

interface AndroidAgentNotifications {
  configure(
    deviceId: string,
    userId: string,
    scheme: string,
    ongoingEnabled: boolean,
    approvalActions: ReadonlyArray<{ id: string; label: string; progress: string }>,
  ): void;
  clear(): void;
  setThreadOnScreen?(path: string | null): void;
  openLiveUpdateSettings?(): boolean;
  showShowcaseActivity?(scheme: string, data: Record<string, string>): void;
  finishApprovalAction?(notificationId: number): void;
  failApprovalAction?(notificationId: number, message: string): void;
  cancelResolvedApprovals?(environmentId: string, pendingRequestIds: ReadonlyArray<string>): void;
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<AndroidAgentNotifications>("T3AgentNotifications")
    : null;

export function supportsAndroidAgentNotifications(): boolean {
  return typeof native?.configure === "function" && typeof native?.clear === "function";
}

function appScheme(): string {
  const scheme = Constants.expoConfig?.scheme;
  return (Array.isArray(scheme) ? scheme[0] : scheme) ?? "t3code";
}

export function configureAndroidAgentNotifications(
  deviceId: string,
  userId: string,
  ongoingEnabled: boolean,
): void {
  native?.configure?.(
    deviceId,
    userId,
    appScheme(),
    ongoingEnabled,
    Object.entries(APPROVAL_ACTIONS).map(([id, { label, progress }]) => ({ id, label, progress })),
  );
}

export function showAndroidShowcaseAgentActivity(data: Record<string, string>): boolean {
  if (!native?.showShowcaseActivity) return false;
  native.showShowcaseActivity(appScheme(), data);
  return true;
}

export function clearAndroidAgentNotifications(): void {
  native?.clear?.();
}

export function setAndroidThreadOnScreen(path: string | null): void {
  native?.setThreadOnScreen?.(path);
}

export function supportsAndroidLiveUpdateSettings(): boolean {
  return Platform.OS === "android" && Number(Platform.Version) >= 36;
}

export async function openAndroidLiveUpdateSettings(): Promise<void> {
  if (!native?.openLiveUpdateSettings?.()) {
    await Linking.openSettings();
  }
}

export function cancelResolvedAndroidApprovals(
  environmentId: string,
  pendingRequestIds: ReadonlyArray<string>,
): void {
  native?.cancelResolvedApprovals?.(environmentId, pendingRequestIds);
}

export function finishAndroidApprovalAction(notificationId: number): void {
  native?.finishApprovalAction?.(notificationId);
}

export function failAndroidApprovalAction(notificationId: number, message: string): void {
  native?.failApprovalAction?.(notificationId, message);
}
