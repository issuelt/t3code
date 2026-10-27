import { RegistryContext } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { EnvironmentId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";
import { useNavigate } from "@tanstack/react-router";
import { use, useEffect, useLayoutEffect, useRef, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { useStableCallback } from "../hooks/useStableCallback";
import {
  dictationEnvironment,
  useDictationEnvironmentId,
  useDictationState,
} from "../state/dictation";
import { createStreamingDictation } from "./streamingDictation";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

type DraftSelection = { readonly start: number; readonly end: number };

type ComposerDictationInput = Parameters<typeof useComposerDictation>[0] & {
  readonly environmentId: EnvironmentId | null;
  readonly modelLoaded: boolean;
};

/**
 * Wires a controller to the composer's latest input, read when callbacks run.
 * It owns that input instead of taking refs, so React Compiler can memoize the hook.
 */
function createComposerDictationController(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly initial: ComposerDictationInput;
  readonly setState: (state: VoiceInputState) => void;
}) {
  const latest = { current: input.initial };
  const committed = { current: false };
  let controller: VoiceInputController | null = null;
  const streaming = createStreamingDictation({
    registry: input.registry,
    resolveEnvironmentId: () => latest.current.environmentId,
    interrupt: (message) => void controller?.interruptRecording(message),
    rewriteTranscript: (text) => latest.current.rewriteTranscript(text),
    finishedAtLimit: (uri) =>
      void controller?.handleRecorderStatus({
        isFinished: true,
        hasError: false,
        error: null,
        url: uri,
      }),
  });
  const created = new VoiceInputController({
    ...streaming.dependencies,
    readDraft: () => {
      const draft = latest.current.readDraft();
      return draft && { ...draft, ownerKey: latest.current.ownerKey, revision: 0 };
    },
    commitDraft: (text, selection, inserted) => {
      committed.current = true;
      latest.current.commitDraft(text, selection, inserted);
    },
    // Render first, so the UI follows the controller even if cleanup throws.
    onStateChange: (next) => {
      input.setState(next);
      streaming.settle(next);
    },
  });
  controller = created;
  return {
    controller: created,
    level: streaming.level,
    capturedAudio: streaming.capturedAudio,
    latest: () => latest.current,
    setLatest: (next: ComposerDictationInput) => {
      latest.current = next;
    },
    /** Whether a transcript was committed since the last call. */
    takeCommitted: () => {
      const was = committed.current;
      committed.current = false;
      return was;
    },
  };
}

/**
 * Dictation for one composer. Audio streams to the environment picked by
 * `useDictationEnvironmentId`, and the transcript lands at the selection the
 * draft had when recording started. The draft is frozen while `active`, so the
 * composer should block submission and editing until it clears.
 */
export function useComposerDictation(input: {
  /** Identifies the text being dictated into; a change cancels a running dictation. */
  readonly ownerKey: string;
  readonly draftEnvironmentId: EnvironmentId | null;
  readonly readDraft: () => { readonly text: string; readonly selection: DraftSelection } | null;
  /** `inserted` is where the transcript landed in `text`. */
  readonly commitDraft: (text: string, selection: DraftSelection, inserted: DraftSelection) => void;
  /** Applied to the transcript before insertion; read when the transcript arrives. */
  readonly rewriteTranscript: (text: string) => string;
  /** Runs once the editor is unfrozen after a transcript was inserted. */
  readonly onCommitted: () => void;
}) {
  const registry = use(RegistryContext);
  const navigate = useNavigate();
  const environmentId = useDictationEnvironmentId(input.draftEnvironmentId);
  const { state: environmentState } = useDictationState(environmentId);
  const modelLoaded = environmentState?.loadedModel != null;
  const [state, setState] = useState(IDLE_STATE);
  const [dictation] = useState(() =>
    createComposerDictationController({
      registry,
      initial: { ...input, environmentId, modelLoaded },
      setState,
    }),
  );
  const { controller, level, capturedAudio } = dictation;
  // oxlint-disable-next-line t3code/react-effect-budget -- the controller outlives renders and reads the latest input, which must not be written during render
  useLayoutEffect(() => {
    dictation.setLatest({ ...input, environmentId, modelLoaded });
  });

  const ownerKey = useRef(input.ownerKey);
  // oxlint-disable-next-line t3code/react-effect-budget -- switching drafts or questions abandons the controller's in-flight recording
  useEffect(() => {
    if (ownerKey.current === input.ownerKey) return;
    ownerKey.current = input.ownerKey;
    controller.ownerChanged();
  }, [controller, input.ownerKey]);

  // oxlint-disable-next-line t3code/react-effect-budget -- releases the microphone and worker when the composer unmounts
  useEffect(() => () => controller.dispose(), [controller]);

  // The editor is enabled again by the time this parent effect runs.
  // oxlint-disable-next-line t3code/react-effect-budget -- focusing the editor needs it enabled, which happens only after this commit
  useEffect(() => {
    if (state.phase !== "idle" || !dictation.takeCommitted()) return;
    dictation.latest().onCommitted();
  }, [dictation, state.phase]);

  // oxlint-disable-next-line t3code/react-effect-budget -- errors arrive from the async controller, not from a handler here
  useEffect(() => {
    if (state.phase !== "error" || state.error === null) return;
    toastManager.add({ type: "error", title: state.error });
    controller.cancel();
  }, [controller, state]);

  // Stable across renders so callers can run it from an effect keyed only on focus.
  const warm = useStableCallback(() => {
    const { environmentId: target, modelLoaded: loaded } = dictation.latest();
    if (target === null || loaded) return;
    void runAtomCommand(
      registry,
      dictationEnvironment.warm,
      { environmentId: target, input: {} },
      { reportFailure: false },
    );
  });

  const openSettings = () =>
    void navigate({
      to: "/settings/integrations",
      hash: "dictation",
      search: { machine: dictation.latest().draftEnvironmentId ?? undefined },
      state: { settingsTargetHighlight: true },
    });

  return {
    state,
    environmentId,
    /** Microphone level for recording visuals; subscribe instead of rendering it. */
    level,
    /** True while dictation can still change the draft. */
    active: voiceInputBlocksSubmission(state),
    /** The controller's phase right now, ahead of the next render. */
    readPhase: () => controller.currentState.phase,
    /** True once this dictation has captured audio, which starts before recording does. */
    capturedAudio,
    /** Starts recording, or opens Dictation settings when no environment can transcribe. */
    start: () => {
      if (dictation.latest().environmentId === null) {
        openSettings();
        return;
      }
      void controller.start();
    },
    /**
     * Starts loading the speech model if it is not loaded yet, so a dictation
     * that follows soon does not wait for it. Call when the composer gains focus.
     */
    warm,
    /** Stops recording and inserts the transcript; while preparing, as soon as recording starts. */
    stop: () => void controller.stop(),
    cancel: () => controller.cancel(),
  };
}

export type ComposerDictation = ReturnType<typeof useComposerDictation>;
