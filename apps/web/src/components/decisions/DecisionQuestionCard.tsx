import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import {
  buildPendingUserInputAnswers,
  isPendingUserInputOptionSelected,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import {
  seedUserInputDraftAnswers,
  type ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import { useState, type ReactNode } from "react";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand, useCommandStatus } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { RequestCard } from "../chat/RequestCard";
import { UserInputOptionRow } from "../chat/UserInputOptionRow";
import { Button, InlineButton } from "../ui/button";
import { Textarea } from "../ui/textarea";

export function DecisionQuestionCard({
  thread,
  label,
  heading,
  userInput,
  actions,
}: {
  thread: ScopedThreadRef;
  label: string;
  heading: ReactNode;
  userInput: ThreadPendingUserInput;
  actions?: ReactNode;
}) {
  const canRespond = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToUserInput, { reportFailure: false });
  const dismiss = useAtomCommand(threadEnvironment.dismissUserInput, { reportFailure: false });
  const [edits, setEdits] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const { pending: responding, error, run } = useCommandStatus();
  const drafts = seedUserInputDraftAnswers(userInput.questions, edits);
  const answers = buildPendingUserInputAnswers(userInput.questions, drafts);
  const editDraft = (
    questionId: string,
    change: (draft: PendingUserInputDraftAnswer | undefined) => PendingUserInputDraftAnswer,
  ) =>
    setEdits((current) => ({
      ...current,
      [questionId]: change(seedUserInputDraftAnswers(userInput.questions, current)[questionId]),
    }));
  const disabled = !canRespond || responding || userInput.responseCapability === "not_resumable";
  const target = { environmentId: thread.environmentId };
  const submit = () => {
    if (answers === null) return;
    void run(
      () =>
        respond({
          ...target,
          input: { threadId: thread.threadId, requestId: userInput.requestId, answers },
        }),
      "Failed to send the answer.",
    );
  };
  const dismissQuestion = () =>
    void run(
      () =>
        dismiss({
          ...target,
          input: { threadId: thread.threadId, requestId: userInput.requestId },
        }),
      "Failed to dismiss the question.",
    );
  return (
    <RequestCard
      label={label}
      heading={heading}
      error={error}
      actions={
        <>
          <Button size="sm" disabled={disabled || answers === null} onClick={submit}>
            Submit answer
          </Button>
          {userInput.dismissible ? (
            <InlineButton
              tone="muted"
              disabled={disabled}
              title="Dismiss question without answering"
              onClick={dismissQuestion}
            >
              Dismiss
            </InlineButton>
          ) : null}
          {actions}
        </>
      }
    >
      {userInput.questions.map((question) => {
        const draft = drafts[question.id];
        return (
          <fieldset key={question.id} className="mb-2" disabled={disabled}>
            <legend className="text-muted-foreground">{question.header}</legend>
            <ChatMarkdown
              text={question.question}
              cwd={undefined}
              threadRef={thread}
              lineBreaks
              className="pt-0.5 text-foreground/85"
            />
            {question.options.length > 0 ? (
              <div className="-ms-2 mt-1.5 sm:-ms-1.5">
                {question.options.map((option) => {
                  const value = option.value ?? option.label;
                  return (
                    <UserInputOptionRow
                      key={value}
                      option={option}
                      multiSelect={question.multiSelect}
                      selected={isPendingUserInputOptionSelected(question, draft, value)}
                      disabled={disabled}
                      onSelect={() =>
                        editDraft(question.id, (current) =>
                          togglePendingUserInputOptionSelection(question, current, value),
                        )
                      }
                      cwd={undefined}
                      threadRef={thread}
                    />
                  );
                })}
              </div>
            ) : null}
            {question.allowCustomAnswer === false ? null : (
              <Textarea
                className="mt-1.5"
                size="sm"
                rows={2}
                aria-label={`Answer to ${question.header}`}
                placeholder={question.options.length > 0 ? "Or write an answer" : "Write an answer"}
                value={draft?.customAnswer ?? ""}
                onChange={(event) => {
                  const text = event.target.value;
                  editDraft(question.id, (current) =>
                    setPendingUserInputCustomAnswer(question, current, text),
                  );
                }}
              />
            )}
          </fieldset>
        );
      })}
    </RequestCard>
  );
}
