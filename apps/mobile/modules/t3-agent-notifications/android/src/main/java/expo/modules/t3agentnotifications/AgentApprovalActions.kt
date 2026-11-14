package expo.modules.t3agentnotifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/** Identifiers match `t3.approval.*` in the app's `approvalActions.ts`. */
enum class ApprovalAction(val id: String, val label: String, val progress: String) {
  Accept("t3.approval.accept", "Allow once", "Allowing…"),
  Decline("t3.approval.decline", "Decline", "Declining…");

  companion object {
    fun from(id: String?) = entries.firstOrNull { it.id == id }
  }
}

sealed interface ApprovalAlertState {
  data object Ready : ApprovalAlertState
  data class Sending(val action: ApprovalAction) : ApprovalAlertState
  data class Failed(val environmentLabel: String) : ApprovalAlertState
}

data class ApprovalRequest(
  val environmentId: String,
  val threadId: String,
  val requestId: String,
  val actionable: Boolean
) {
  companion object {
    fun from(data: Map<String, String>): ApprovalRequest? {
      val environmentId = data[AgentNotifications.ENVIRONMENT_ID] ?: return null
      val threadId = data[AgentNotifications.REQUEST_THREAD_ID] ?: return null
      val requestId = data[AgentNotifications.REQUEST_ID] ?: return null
      return ApprovalRequest(
        environmentId,
        threadId,
        requestId,
        data[AgentNotifications.REQUEST_ACTIONABLE] == "true"
      )
    }
  }
}

class AgentApprovalActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val action = ApprovalAction.from(intent.action) ?: return
    val notificationId = intent.getIntExtra(AgentNotifications.NOTIFICATION_ID_EXTRA, 0)
    val request = AgentNotifications.beginApprovalAction(context, notificationId, action) ?: return
    val task = Intent(context, AgentApprovalTaskService::class.java)
      .putExtra("actionIdentifier", action.id)
      .putExtra("notificationId", notificationId)
      .putExtra("environmentId", request.environmentId)
      .putExtra("threadId", request.threadId)
      .putExtra("requestId", request.requestId)
    HeadlessJsTaskService.acquireWakeLockNow(context)
    context.startService(task)
  }
}

/** Runs the `T3ApprovalAction` headless task registered in the app's index. */
class AgentApprovalTaskService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
    val extras: Bundle = intent?.extras ?: return null
    return HeadlessJsTaskConfig(TASK_NAME, Arguments.fromBundle(extras), TASK_TIMEOUT_MS, true)
  }

  private companion object {
    const val TASK_NAME = "T3ApprovalAction"
    const val TASK_TIMEOUT_MS = 30_000L
  }
}
