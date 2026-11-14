import { failAndroidApprovalAction, finishAndroidApprovalAction } from "./androidNotifications";
import { androidApprovalTask, unreachableText } from "./approvalActions";
import { answerApproval } from "./approvalAnswers";

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
