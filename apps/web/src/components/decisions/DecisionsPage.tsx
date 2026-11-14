import { useAtomValue } from "@effect/atom-react";
import { openDecisionKey, type OpenDecision } from "@t3tools/client-runtime/state/thread-requests";
import { useNavigate } from "@tanstack/react-router";
import { MessageCircleQuestionIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { openDecisions } from "../../state/threads";
import { buildThreadRouteParams } from "../../threadRoutes";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { useEnvironmentLookups } from "../CommandPaletteLookups";
import { PendingApprovalCard } from "../chat/PendingApprovalCard";
import { RelativeTime } from "../RelativeTime";
import { SIDEBAR_TOP_STATUS } from "../sidebar/sidebarTopStatus";
import { InlineButton } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { DecisionQuestionCard } from "./DecisionQuestionCard";

function DecisionHeading({
  decision,
  environmentLabel,
}: {
  decision: OpenDecision;
  environmentLabel: string | null;
}) {
  const status = SIDEBAR_TOP_STATUS[decision.kind === "approval" ? "approval" : "input"];
  const Icon = status.Icon ?? MessageCircleQuestionIcon;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon aria-hidden className={cn("size-4 shrink-0", status.className)} />
      <span className="min-w-0 truncate">{decision.title}</span>
      {environmentLabel === null ? null : (
        <span className="shrink-0 font-normal text-muted-foreground">· {environmentLabel}</span>
      )}
      <span className="ms-auto shrink-0 font-normal text-muted-foreground">
        <RelativeTime timestamp={decision.createdAt} />
      </span>
    </span>
  );
}

function Decision({
  decision,
  environmentLabel,
}: {
  decision: OpenDecision;
  environmentLabel: string | null;
}) {
  const navigate = useNavigate();
  const heading = <DecisionHeading decision={decision} environmentLabel={environmentLabel} />;
  const openThread = (
    <InlineButton
      tone="muted"
      onClick={() =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(decision.thread),
        })
      }
    >
      Open thread
    </InlineButton>
  );
  if (decision.kind === "approval")
    return (
      <PendingApprovalCard
        thread={decision.thread}
        label={`Approval from ${decision.title}`}
        heading={heading}
        approval={decision.approval}
        actions={openThread}
      />
    );
  if (decision.kind === "question")
    return (
      <DecisionQuestionCard
        thread={decision.thread}
        label={`Question from ${decision.title}`}
        heading={heading}
        userInput={decision.userInput}
        actions={openThread}
      />
    );
  return (
    <section
      aria-label={`Request from ${decision.title}`}
      className="rounded-lg border border-border bg-background p-3 text-xs"
    >
      <p className="mb-2 font-medium">{heading}</p>
      <p className="mb-2 text-muted-foreground">
        Only you can answer this. Open the thread to respond.
      </p>
      {openThread}
    </section>
  );
}

export function DecisionsPage() {
  const decisions = useAtomValue(openDecisions.decisionsAtom);
  const { environmentLabelById } = useEnvironmentLookups();
  const showEnvironment =
    new Set(decisions.map((decision) => decision.thread.environmentId)).size > 1;
  return (
    <AppRouteModal label="Decisions">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 items-center gap-1 border-b ps-5 pe-2">
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">Decisions</h1>
          <AppRouteModalClose />
        </header>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer>
            {decisions.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <MessageCircleQuestionIcon />
                  </EmptyMedia>
                  <EmptyTitle>Nothing waiting on you</EmptyTitle>
                  <EmptyDescription>
                    Approvals, questions, and decisions from your agents appear here.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex flex-col gap-2">
                {decisions.map((decision) => (
                  <Decision
                    key={openDecisionKey(decision)}
                    decision={decision}
                    environmentLabel={
                      showEnvironment
                        ? (environmentLabelById.get(decision.thread.environmentId) ?? null)
                        : null
                    }
                  />
                ))}
              </div>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </AppRouteModal>
  );
}
