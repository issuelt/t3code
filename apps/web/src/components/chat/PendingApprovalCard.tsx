import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import type { ThreadPendingApproval } from "@t3tools/client-runtime/state/thread-requests";
import { fullAccessOverrideExplanation } from "@t3tools/client-runtime/state/thread-requests";
import type { ReactNode } from "react";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand, useCommandStatus } from "../../state/use-atom-command";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
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
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono">
        {approval.detail || approval.requestKind}
      </pre>
      {approval.appName ? <p className="mt-2 text-muted-foreground">{approval.appName}</p> : null}
      {approval.responseCapability !== "live" ? (
        <p className="mt-2 text-warning">
          Provider process is gone. Interrupt or restart the thread to respond.
        </p>
      ) : null}
      {approval.reason ? <p className="mt-2 text-muted-foreground">{approval.reason}</p> : null}
      {approval.fullAccessOverride ? (
        <p className="mt-2 text-muted-foreground">
          {fullAccessOverrideExplanation(approval.fullAccessOverride)}
        </p>
      ) : null}
    </RequestCard>
  );
}
