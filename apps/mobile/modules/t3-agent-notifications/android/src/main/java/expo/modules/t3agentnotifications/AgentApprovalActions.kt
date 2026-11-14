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

/** Ties each headless task to its alert, so a task that ends unreported fails only that alert. */
class ApprovalTasks(private val settle: (notificationId: Int) -> Unit) {
  private val queued = ArrayDeque<Int>()
  private val alertByTask = mutableMapOf<Int, Int>()

  fun queue(notificationId: Int) {
    queued.addLast(notificationId)
  }

  // Adding the listener replays running tasks; only an unseen id is the task just started.
  fun started(taskId: Int) {
    if (taskId in alertByTask) return
    queued.removeFirstOrNull()?.let { alertByTask[taskId] = it }
  }

  fun finished(taskId: Int) {
    alertByTask.remove(taskId)?.let(settle)
  }

  fun expire(notificationId: Int) {
    queued.remove(notificationId)
    alertByTask.values.remove(notificationId)
    settle(notificationId)
  }

  fun settleAll() {
    val pending = queued + alertByTask.values
    queued.clear()
    alertByTask.clear()
    pending.forEach(settle)
  }
}

class AgentApprovalTaskService : HeadlessJsTaskService() {
  private val tasks = ApprovalTasks { AgentNotifications.failUnreportedApproval(this, it) }
  private val handler = Handler(Looper.getMainLooper())

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
    val extras: Bundle = intent?.extras ?: return null
    val notificationId = extras.getInt("notificationId")
    tasks.queue(notificationId)
    // A JS runtime that never boots never ends the task either.
    handler.postDelayed({ tasks.expire(notificationId) }, TASK_TIMEOUT_MS + BOOT_GRACE_MS)
    return HeadlessJsTaskConfig(TASK_NAME, Arguments.fromBundle(extras), TASK_TIMEOUT_MS, true)
  }

  override fun onHeadlessJsTaskStart(taskId: Int) {
    tasks.started(taskId)
  }

  override fun onHeadlessJsTaskFinish(taskId: Int) {
    tasks.finished(taskId)
    super.onHeadlessJsTaskFinish(taskId)
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    tasks.settleAll()
    super.onDestroy()
  }

  private companion object {
    const val TASK_NAME = "T3ApprovalAction"
    const val TASK_TIMEOUT_MS = 30_000L
    const val BOOT_GRACE_MS = 5_000L
  }
}
