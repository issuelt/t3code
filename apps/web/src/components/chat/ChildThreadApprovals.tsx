import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { childThreadApprovalsAtom } from "../../state/threads";
import { PendingApprovalCard } from "./PendingApprovalCard";

export function ChildThreadApprovals({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const approvals = useAtomValue(childThreadApprovalsAtom(threadRef));
  if (approvals.length === 0) return null;
  return (
    <div className="mb-2 flex max-h-80 flex-col gap-2 overflow-auto">
      {approvals.map((entry) => (
        <PendingApprovalCard
          key={JSON.stringify([
            entry.thread.environmentId,
            entry.thread.threadId,
            entry.approval.requestId,
          ])}
          thread={entry.thread}
          label={`Approval from ${entry.title}`}
          heading={`Approval needed from ${entry.title}`}
          approval={entry.approval}
        />
      ))}
    </div>
  );
}
