package expo.modules.t3agentnotifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/** One of the app's `APPROVAL_ACTIONS`, stored by `configure`. */
data class ApprovalAction(val id: String, val label: String, val progress: String)

sealed interface ApprovalAlertState {
  data object Ready : ApprovalAlertState
  data class Sending(val action: ApprovalAction) : ApprovalAlertState
  data class Failed(val message: String) : ApprovalAlertState
  data class Rejected(val message: String) : ApprovalAlertState
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
    val action = AgentNotifications.approvalActions(context).firstOrNull { it.id == intent.action }
      ?: return
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

class AgentApprovalTaskService : HeadlessJsTaskService() {
  private val notificationIds = mutableSetOf<Int>()
  private val handler = Handler(Looper.getMainLooper())

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
    val extras: Bundle = intent?.extras ?: return null
    val notificationId = extras.getInt("notificationId")
    notificationIds += notificationId
    // A JS runtime that never boots never ends the task either.
    handler.postDelayed({ settle(notificationId) }, TASK_TIMEOUT_MS + BOOT_GRACE_MS)
    return HeadlessJsTaskConfig(TASK_NAME, Arguments.fromBundle(extras), TASK_TIMEOUT_MS, true)
  }

  override fun onHeadlessJsTaskFinish(taskId: Int) {
    notificationIds.toList().forEach(::settle)
    super.onHeadlessJsTaskFinish(taskId)
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    notificationIds.toList().forEach(::settle)
    super.onDestroy()
  }

  private fun settle(notificationId: Int) {
    notificationIds -= notificationId
    AgentNotifications.failUnreportedApproval(this, notificationId)
  }

  private companion object {
    const val TASK_NAME = "T3ApprovalAction"
    const val TASK_TIMEOUT_MS = 30_000L
    const val BOOT_GRACE_MS = 5_000L
  }
}
