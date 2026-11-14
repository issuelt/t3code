import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentShell } from "../../state/shell";
import { environmentThreadShells } from "../../state/threads";
import { cancelResolvedAndroidApprovals } from "./androidNotifications";
import { decodeApprovalNotificationData } from "./approvalActions";

/** Pending requests of environments whose shell is live; others are unknown, so left alone. */
const livePendingRequestsAtom = Atom.make((get) => {
  const pending = new Map<EnvironmentId, Set<string>>();
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    if (get(environmentShell.stateValueAtom(environmentId)).status === "live") {
      pending.set(environmentId, new Set());
    }
  }
  for (const thread of get(environmentThreadShells.threadShellsAtom)) {
    if (thread.pendingApprovalRequestId) {
      pending.get(thread.environmentId)?.add(thread.pendingApprovalRequestId);
    }
  }
  return pending;
}).pipe(Atom.withLabel("approval-notifications:live-pending-requests"));

async function dismissResolvedIosApprovals(
  environmentId: EnvironmentId,
  pending: ReadonlySet<string>,
): Promise<void> {
  const presented = await Notifications.getPresentedNotificationsAsync();
  await Promise.all(
    presented.flatMap((notification) =>
      Option.match(decodeApprovalNotificationData(notification.request.content.data), {
        onNone: () => [],
        onSome: (data) =>
          data.environmentId === environmentId && !pending.has(data.pendingApproval.requestId)
            ? [Notifications.dismissNotificationAsync(notification.request.identifier)]
            : [],
      }),
    ),
  );
}

/**
 * While the app runs, an approval answered anywhere (web, desktop, another phone) clears its
 * alert here as soon as the shell stream reports it.
 */
export function installApprovalNotificationClearing(): () => void {
  const reconciled = new Map<EnvironmentId, string>();
  return appAtomRegistry.subscribe(
    livePendingRequestsAtom,
    (pendingByEnvironment) => {
      for (const [environmentId, pending] of pendingByEnvironment) {
        const key = [...pending].sort().join(",");
        if (reconciled.get(environmentId) === key) continue;
        reconciled.set(environmentId, key);
        if (Platform.OS === "android") {
          cancelResolvedAndroidApprovals(environmentId, [...pending]);
        } else if (Platform.OS === "ios") {
          void dismissResolvedIosApprovals(environmentId, pending).catch((cause: unknown) =>
            console.error("[approval-actions] could not clear answered approvals", cause),
          );
        }
      }
    },
    { immediate: true },
  );
}
