package expo.modules.t3agentnotifications

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3AgentNotificationsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3AgentNotifications")

    Function("configure") {
        deviceId: String,
        userId: String,
        scheme: String,
        ongoingEnabled: Boolean,
        approvalActions: List<Map<String, String>>,
        approvalInterruptedText: String
      ->
      val actions = approvalActions.mapNotNull { action ->
        val id = action["id"] ?: return@mapNotNull null
        val label = action["label"] ?: return@mapNotNull null
        val progress = action["progress"] ?: return@mapNotNull null
        ApprovalAction(id, label, progress)
      }
      appContext.reactContext?.let {
        AgentNotifications.configure(
          it,
          deviceId,
          userId,
          scheme,
          ongoingEnabled,
          actions,
          approvalInterruptedText
        )
      }
    }

    Function("clear") {
      appContext.reactContext?.let { AgentNotifications.clear(it) }
    }

    Function("showShowcaseActivity") { scheme: String, data: Map<String, String> ->
      appContext.reactContext?.let { AgentNotifications.showcase(it, scheme, data) }
    }

    Function("finishApprovalAction") { notificationId: Int ->
      appContext.reactContext?.let { AgentNotifications.cancelAlert(it, notificationId) }
    }

    Function("failApprovalAction") { notificationId: Int, message: String ->
      appContext.reactContext?.let {
        AgentNotifications.showApprovalFailure(it, notificationId, message)
      }
    }

    Function("rejectApprovalAction") { notificationId: Int, message: String ->
      appContext.reactContext?.let {
        AgentNotifications.showApprovalRejected(it, notificationId, message)
      }
    }

    Function("cancelResolvedApprovals") { environmentId: String, pendingRequestIds: List<String> ->
      appContext.reactContext?.let {
        val pending = pendingRequestIds.toSet()
        AgentNotifications.cancelApprovals(it) { extras ->
          extras.getString(AgentNotifications.ENVIRONMENT_ID) == environmentId &&
            extras.getString(AgentNotifications.REQUEST_ID) !in pending
        }
      }
    }

    Function("setThreadOnScreen") { path: String? ->
      AgentNotifications.setThreadOnScreen(path)
    }

    Function("openLiveUpdateSettings") {
      val context = appContext.reactContext
      if (context == null || Build.VERSION.SDK_INT < 36) {
        false
      } else {
        try {
          context.startActivity(
            Intent(Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS)
              .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          )
          true
        } catch (_: ActivityNotFoundException) {
          false
        }
      }
    }
  }
}
