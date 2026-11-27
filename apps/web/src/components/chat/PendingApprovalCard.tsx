import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { T, useMessages } from "gt-react";
import type { ThreadPendingApproval } from "@t3tools/client-runtime/state/thread-requests";
import {
  fullAccessOverrideExplanation,
  PUSH_HOOKS_APPROVAL_QUESTION,
} from "@t3tools/client-runtime/state/thread-requests";
import type { ReactNode } from "react";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand, useCommandStatus } from "../../state/use-atom-command";
import { ApprovalText } from "./ApprovalText";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { PushHooksApprovalDetails } from "./PushHooksApprovalDetails";
import { RequestCard } from "./RequestCard";

export function PendingApprovalCard({
  thread,
  label,
  heading,
  approval,
  actions,
}: {
  thread: ScopedThreadRef;
  label: string;
  heading: ReactNode;
  approval: ThreadPendingApproval;
  actions?: ReactNode;
}) {
  const canRespond = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const { pending: responding, error, run } = useCommandStatus();
  const messages = useMessages();
  return (
    <RequestCard
      label={label}
      heading={heading}
      error={error}
      actions={
        <>
          <ComposerPendingApprovalActions
            presentation="inline"
            requestId={approval.requestId}
            isResponding={responding}
            canRespond={approval.responseCapability === "live"}
            disabled={!canRespond}
            options={approval.options}
            onRespondToApproval={async (requestId, decision) => {
              if (!canRespond || responding) return;
              return run(
                () =>
                  respond({
                    environmentId: thread.environmentId,
                    input: { threadId: thread.threadId, requestId, decision },
                  }),
                "Failed to submit approval decision.",
              );
            }}
          />
          {actions}
        </>
      }
    >
      {approval.pushHooks ? (
        <>
          <p className="mb-1">{messages(PUSH_HOOKS_APPROVAL_QUESTION)}</p>
          <PushHooksApprovalDetails pushHooks={approval.pushHooks} />
        </>
      ) : (
        <ApprovalText text={approval.detail || approval.requestKind} />
      )}
      {approval.appName ? <p className="mt-2 text-muted-foreground">{approval.appName}</p> : null}
      {approval.responseCapability !== "live" ? (
        <p className="mt-2 text-warning">
          <T>Provider process is gone. Interrupt or restart the thread to respond.</T>
        </p>
      ) : null}
      {approval.reason ? <p className="mt-2 text-muted-foreground">{approval.reason}</p> : null}
      {approval.fullAccessOverride ? (
        <p className="mt-2 text-muted-foreground">
          {fullAccessOverrideExplanation(approval.fullAccessOverride, messages)}
        </p>
      ) : null}
    </RequestCard>
  );
}
