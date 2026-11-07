import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ChatAttachmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  emitThreadEvent,
  runningRun,
  threadWithHistory,
  userItem,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("a new draft does not load its reserved thread before the server lists it", async () => {
  using _environment = installFakeEnvironment([]);
  using fetchSpy = vi.spyOn(globalThis, "fetch");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-27443");
  const threadId = ThreadId.make("thread-27443");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, { threadId });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  // The shell snapshot has arrived once the sidebar lists the project, so the connection is up.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const threadRequests = fetchSpy.mock.calls
    .map(([input]) => String(input instanceof Request ? input.url : input))
    .filter((url) => url.includes(`/api/orchestration/threads/${threadId}/`));
  // A 404 here marks the thread deleted, and the view never loads it once the send creates it.
  expect(threadRequests).toEqual([]);
});

it("keeps agent attachments and historical coordination outside human queue controls", async () => {
  const original = threadWithHistory("build-check", 1);
  const sender = { ...threadWithHistory("review-agent", 0), title: "Review agent" };
  const first = original.items[0];
  if (first?.type !== "user_message") throw new Error("Expected fixture prompt");
  const delivered = {
    ...userItem(
      original.id,
      RunId.make("agent-delivery"),
      "agent-delivered",
      2,
      "Review finished. The focused checks passed.",
    ),
    createdBy: "agent" as const,
    creationSource: "mcp" as const,
    senderThreadId: sender.id,
    attachments: [
      {
        type: "file" as const,
        id: ChatAttachmentId.make("coordination-file"),
        name: "review-evidence.txt",
        mimeType: "text/plain",
        sizeBytes: 17,
      },
    ],
  };
  const thread = {
    ...original,
    title: "Build verification",
    items: [
      { ...first, text: "Check the build and report the result." },
      ...original.items.slice(1),
      delivered,
    ],
  };
  using _environment = installFakeEnvironment([thread, sender]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1400, 900);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height:900px;width:1400px";
  await using _app = await render(<AppRoot router={router} />, {
    container,
    // AppRoot supplies its own router.
    router: false,
  });
  await expect
    .element(page.getByText("Check the build and report the result.", { exact: true }))
    .toBeVisible();
  for (const [index, agent] of [true, false].entries()) {
    const id = `queued-${agent ? "agent" : "human"}`;
    const text = agent
      ? "The packaging check is ready for review."
      : "Also check the Linux package.";
    const run = {
      ...runningRun(thread.id, id, index + 3, id),
      status: "queued" as const,
      startedAt: null,
    };
    const item = {
      ...userItem(thread.id, run.id, id, index + 3, text),
      status: "pending" as const,
      completedAt: null,
      inputIntent: "queued_turn" as const,
      ...(agent
        ? { createdBy: "agent" as const, creationSource: "mcp" as const, senderThreadId: sender.id }
        : {}),
    };
    await act(async () => {
      await emitThreadEvent(thread.id, {
        type: "message.updated",
        payload: {
          id: MessageId.make(id),
          threadId: thread.id,
          runId: run.id,
          nodeId: null,
          role: "user",
          text,
          attachments: [],
          streaming: false,
          createdAt: first.updatedAt,
          updatedAt: first.updatedAt,
          createdBy: item.createdBy,
          creationSource: item.creationSource,
          ...(agent ? { senderThreadId: sender.id } : {}),
        },
      });
      await emitThreadEvent(thread.id, { type: "run.created", payload: run });
      if (!agent) await emitThreadEvent(thread.id, { type: "turn-item.updated", payload: item });
    });
  }
  await expect
    .element(page.getByText("Also check the Linux package.", { exact: true }))
    .toBeVisible();
  await vi.waitFor(() => expect(document.querySelectorAll("[data-agent-message]")).toHaveLength(2));
  expect(document.querySelectorAll("[data-agent-message][aria-expanded=false]")).toHaveLength(2);
  expect(document.body.textContent?.match(/Send now/g)).toHaveLength(1);
  await document.fonts.ready;

  await page
    .getByRole("button", { name: "Message from Review agent", exact: true })
    .first()
    .click();
  await expect
    .element(page.getByText("Review finished. The focused checks passed.", { exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Message from Review agent", exact: true }).nth(1).click();
  await expect
    .element(page.getByText("The packaging check is ready for review.", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByText("review-evidence.txt", { exact: true })).toBeVisible();
});
