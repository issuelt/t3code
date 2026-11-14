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
import { UserInputOptionBody } from "../chat/ComposerPendingUserInputPanel";
import { InlineButton } from "../ui/button";
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
  return (
    <section
      aria-label={label}
      className="rounded-lg border border-border bg-background p-3 text-xs"
    >
      <p className="mb-2 font-medium">{heading}</p>
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
              <div className="mt-1.5 flex flex-col">
                {question.options.map((option) => {
                  const value = option.value ?? option.label;
                  const selected = isPendingUserInputOptionSelected(question, draft, value);
                  return (
                    <div key={value}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() =>
                          editDraft(question.id, (current) =>
                            togglePendingUserInputOptionSelection(question, current, value),
                          )
                        }
                        className="flex w-full items-start gap-2.5 rounded-md py-1.5 ps-1.5 text-left outline-none hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <UserInputOptionBody
                          option={option}
                          multiSelect={question.multiSelect}
                          selected={selected}
                        />
                      </button>
                      {option.preview ? (
                        <ChatMarkdown
                          text={option.preview}
                          cwd={undefined}
                          threadRef={thread}
                          lineBreaks
                          className="ps-8 pb-1.5 text-xs text-foreground/70"
                        />
                      ) : null}
                    </div>
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
      <div className="flex flex-wrap gap-2">
        <InlineButton
          disabled={disabled || answers === null}
          onClick={() => {
            if (answers === null) return;
            void run(
              () =>
                respond({
                  ...target,
                  input: { threadId: thread.threadId, requestId: userInput.requestId, answers },
                }),
              "Failed to send the answer.",
            );
          }}
        >
          Send answer
        </InlineButton>
        {userInput.dismissible ? (
          <InlineButton
            tone="muted"
            disabled={disabled}
            onClick={() =>
              void run(
                () =>
                  dismiss({
                    ...target,
                    input: { threadId: thread.threadId, requestId: userInput.requestId },
                  }),
                "Failed to dismiss the question.",
              )
            }
          >
            Dismiss
          </InlineButton>
        ) : null}
        {actions}
      </div>
      {error !== null ? (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
