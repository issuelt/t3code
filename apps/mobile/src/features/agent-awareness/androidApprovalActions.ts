import {
  failAndroidApprovalAction,
  finishAndroidApprovalAction,
  rejectAndroidApprovalAction,
} from "./androidNotifications";
import { androidApprovalTask, approvalOutcomeText } from "./approvalActions";
import { answerApproval } from "./approvalAnswers";

export async function runAndroidApprovalAction(data: unknown): Promise<void> {
  const task = androidApprovalTask(data);
  if (task === null) {
    console.error("[approval-actions] ignored an approval action with an unexpected payload");
    return;
  }
  const outcome = await answerApproval(task.answer);
  const text = approvalOutcomeText(outcome);
  if (text === null) finishAndroidApprovalAction(task.notificationId);
  else if (outcome._tag === "Rejected") rejectAndroidApprovalAction(task.notificationId, text);
  else failAndroidApprovalAction(task.notificationId, text);
}
