import { failAndroidApprovalAction, finishAndroidApprovalAction } from "./androidNotifications";
import { androidApprovalTask, unreachableText } from "./approvalActions";
import { answerApproval } from "./approvalAnswers";

/**
 * The `T3ApprovalAction` headless task: answers the approval the native alert's action named,
 * then clears the alert, or shows that the environment did not answer with its actions kept.
 */
export async function runAndroidApprovalAction(data: unknown): Promise<void> {
  const task = androidApprovalTask(data);
  if (task === null) {
    console.error("[approval-actions] ignored an approval action with an unexpected payload");
    return;
  }
  const outcome = await answerApproval(task.answer);
  if (outcome._tag === "Answered") {
    finishAndroidApprovalAction(task.notificationId);
  } else {
    failAndroidApprovalAction(task.notificationId, unreachableText(outcome.environmentLabel));
  }
}
