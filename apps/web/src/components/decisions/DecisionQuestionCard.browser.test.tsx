import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ respond: vi.fn() }));

vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));
vi.mock("../../state/use-atom-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/use-atom-command")>()),
  useAtomCommand: () => state.respond,
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { respondToUserInput: {}, dismissUserInput: {} },
}));

import { DecisionQuestionCard } from "./DecisionQuestionCard";

function clickAllBeforeRerender(elements: ReadonlyArray<Element>) {
  for (const element of elements) element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function setup() {
  state.respond.mockReset();
  state.respond.mockResolvedValue(AsyncResult.success(undefined));
  return {
    thread: { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") },
    userInput: {
      requestId: RuntimeRequestId.make("decision"),
      createdAt: "2026-11-01T00:00:00.000Z",
      questions: [
        {
          id: "decision",
          header: "Docs",
          question: "Which docs hosts?",
          options: [
            { label: "Docs site", description: "docs.example.com" },
            { label: "GitHub Pages", description: "Next to the repo" },
          ],
          multiSelect: true,
          allowCustomAnswer: false,
        },
      ],
      responseCapability: "message" as const,
      responseMode: "message" as const,
      dismissible: true,
    },
  };
}

it("sends every option chosen in quick succession", async () => {
  const { thread, userInput } = setup();
  await using screen = await render(
    <DecisionQuestionCard thread={thread} label="Decision" heading="Docs" userInput={userInput} />,
  );
  clickAllBeforeRerender(
    ["Docs site", "GitHub Pages"].map((name) =>
      screen.getByRole("button", { name: new RegExp(name) }).element(),
    ),
  );
  await screen.getByRole("button", { name: "Send answer" }).click();
  await vi.waitFor(() =>
    expect(state.respond).toHaveBeenCalledWith({
      environmentId: thread.environmentId,
      input: {
        threadId: thread.threadId,
        requestId: userInput.requestId,
        answers: { decision: ["Docs site", "GitHub Pages"] },
      },
    }),
  );
});
