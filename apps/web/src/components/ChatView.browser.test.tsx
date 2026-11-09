import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type VoiceTranscriptionDestination } from "@t3tools/contracts";
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
import { chooseAudioDestination } from "~/speech/voiceConsent";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";
import { useComposerDictation } from "~/dictation/useComposerDictation";
import { useEnvironmentSpeechInput } from "~/speech/useEnvironmentSpeechInput";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/dictation/useComposerDictation"), { spy: true });
vi.mock(import("~/speech/useEnvironmentSpeechInput"), { spy: true });
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

const MICROPHONE_BUTTONS = /^(Dictate|Set up dictation|Start voice input)$/;

async function renderDraftComposer(name: string) {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make(`draft-microphone-${name}`);
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
      threadId: ThreadId.make(`thread-microphone-${name}`),
    });
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  // AppRoot brings its own router.
  return render(<AppRoot router={router} />, { router: false });
}

it.each<{
  readonly state: string;
  readonly destination: VoiceTranscriptionDestination | null;
  readonly microphone: string;
}>([
  { state: "no Voice destination", destination: null, microphone: "Set up dictation" },
  {
    state: "a chosen Voice destination",
    destination: { kind: "cloud", environmentId: ENVIRONMENT_ID, provider: "openai" },
    microphone: "Start voice input",
  },
])("the composer shows one microphone with $state", async ({ destination, microphone }) => {
  using _environment = installFakeEnvironment([]);
  using _voiceChoice = {
    [Symbol.dispose]: () => window.localStorage.removeItem("t3code:voice-audio-grant:v1"),
  };
  if (destination) chooseAudioDestination(destination);
  await using _app = await renderDraftComposer(destination?.kind ?? "none");
  await expect.element(page.getByRole("button", { name: microphone, exact: true })).toBeVisible();

  const microphones = page.getByRole("button", { name: MICROPHONE_BUTTONS }).elements();
  expect(microphones.map((button) => button.getAttribute("aria-label"))).toEqual([microphone]);
});

const isMac = /Mac/.test(navigator.platform);

it.each([
  {
    running: "Voice input",
    chord: { key: " ", code: "Space", altKey: isMac, ctrlKey: !isMac, shiftKey: !isMac },
    visibleControl: "Finish voice input",
  },
  {
    running: "Dictation",
    chord: { key: "d", code: "KeyD", metaKey: isMac, ctrlKey: !isMac, shiftKey: true },
    visibleControl: "Stop and insert dictation",
  },
])("a running $running recording blocks the other shortcut", async (row) => {
  const { useEnvironmentSpeechInput: realVoice } = await vi.importActual<
    typeof import("~/speech/useEnvironmentSpeechInput")
  >("~/speech/useEnvironmentSpeechInput");
  const { useComposerDictation: realDictation } = await vi.importActual<
    typeof import("~/dictation/useComposerDictation")
  >("~/dictation/useComposerDictation");
  const recording = { phase: "recording", error: null, errorAction: null } as const;
  const voiceRunning = row.running === "Voice input";
  const startVoice = vi.fn(async () => {});
  const startDictation = vi.fn();
  using _environment = installFakeEnvironment([]);
  using _voice = vi.mocked(useEnvironmentSpeechInput).mockImplementation((input) => ({
    ...realVoice(input),
    available: true,
    start: startVoice,
    ...(voiceRunning ? { state: recording, blocksSubmission: true } : {}),
  }));
  using _dictation = vi.mocked(useComposerDictation).mockImplementation((input) => ({
    ...realDictation(input),
    start: startDictation,
    ...(voiceRunning ? {} : { state: recording, active: true, readPhase: () => "recording" }),
  }));
  await using _app = await renderDraftComposer(`busy-${row.running}`);
  await expect
    .element(page.getByRole("button", { name: row.visibleControl, exact: true }))
    .toBeVisible();

  window.dispatchEvent(new KeyboardEvent("keydown", { ...row.chord, cancelable: true }));

  expect(startVoice).not.toHaveBeenCalled();
  expect(startDictation).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole("button", { name: row.visibleControl, exact: true }))
    .toBeVisible();
});
