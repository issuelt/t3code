import { describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  compileResolvedKeybindingsConfig,
} from "@t3tools/shared/keybindings";
import { ProviderDriverKind } from "@t3tools/contracts";
import { DraftId } from "../../composerDraftStore";
import { composerCommandKeyHandler } from "./composerCommandKey";

import { nudgeComposerMenuItemId, resolveComposerMenuActiveItemId } from "./composerMenuHighlight";

describe("resolveComposerMenuActiveItemId", () => {
  it("clears the active result while async results are empty and resolves against restored results", () => {
    const search = {
      highlightedItemId: "second",
      currentSearchKey: "path:src",
      highlightedSearchKey: "path:src",
    };
    const cleared = resolveComposerMenuActiveItemId({ ...search, items: [] });
    expect(cleared).toBeNull();
    expect(
      resolveComposerMenuActiveItemId({
        ...search,
        highlightedItemId: cleared,
        items: [{ id: "new-result" }, { id: "second" }],
      }),
    ).toBe("new-result");
  });
});

function keyboardEvent(key: string, modifiers: KeyboardEventInit = {}): KeyboardEvent {
  return Object.assign(new Event("keydown", { cancelable: true }), {
    key,
    code: key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    charCode: 0,
    repeat: false,
    location: 0,
    detail: 0,
    view: null,
    which: 0,
    DOM_KEY_LOCATION_STANDARD: 0 as const,
    DOM_KEY_LOCATION_LEFT: 1 as const,
    DOM_KEY_LOCATION_RIGHT: 2 as const,
    DOM_KEY_LOCATION_NUMPAD: 3 as const,
    getModifierState: () => false,
    initKeyboardEvent: () => {},
    initUIEvent: () => {},
    ...modifiers,
  });
}

function menuHandler(overrides: Partial<Parameters<typeof composerCommandKeyHandler>[0]> = {}) {
  const input: Parameters<typeof composerCommandKeyHandler>[0] = {
    promptSuggestion: null,
    onDismissPromptSuggestion: vi.fn(),
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    sendShortcut: "enter",
    routeKind: "draft",
    phase: "ready",
    isCompacting: false,
    followUpBehavior: "queue",
    isSoftwareKeyboardOpen: false,
    planModeUiEnabled: true,
    isLiteralPendingAnswer: false,
    pendingUserInputs: [],
    promptHistoryMessages: [],
    promptHistoryPositionRef: { current: null },
    composerDraftTarget: DraftId.make("menu-keys"),
    promptRef: { current: "/" },
    composerImagesRef: { current: [] },
    composerFilesRef: { current: [] },
    composerTerminalContextsRef: { current: [] },
    composerPreviewAnnotations: [],
    composerReviewComments: [],
    composerEditorRef: { current: null },
    composerMenuOpenRef: { current: true },
    composerMenuItemsRef: {
      current: [
        {
          id: "first",
          type: "skill",
          provider: ProviderDriverKind.make("codex"),
          skill: { name: "test", path: "/skills/test", enabled: true },
          label: "Test",
          description: "",
        },
        { id: "second", type: "slash-command", command: "plan", label: "Plan", description: "" },
      ],
    },
    activeComposerMenuItemRef: { current: null },
    setComposerDraftPrompt: vi.fn(),
    setComposerCursor: vi.fn(),
    setComposerTrigger: vi.fn(),
    setComposerHighlightedItemId: vi.fn(),
    dismissComposerTrigger: vi.fn(),
    toggleInteractionMode: vi.fn(),
    nudgeComposerMenuHighlight: (key) => {
      const id = nudgeComposerMenuItemId({
        key,
        items: input.composerMenuItemsRef.current,
        highlightedItemId: input.activeComposerMenuItemRef.current?.id ?? null,
      });
      input.activeComposerMenuItemRef.current =
        input.composerMenuItemsRef.current.find((item) => item.id === id) ?? null;
    },
    onSelectComposerItem: vi.fn(),
    resolveActiveComposerTrigger: () => ({ trigger: null }),
    readComposerSnapshot: () => ({ value: "/" }),
    applyPromptReplacement: () => false,
    submitComposer: vi.fn(),
    ...overrides,
  };
  return {
    input,
    handle: (event: KeyboardEvent) => composerCommandKeyHandler(input)(event.key, event),
  };
}

describe("composer menu keyboard navigation", () => {
  it("keeps menu navigation ahead of a configured composer send chord", () => {
    const { input, handle } = menuHandler({
      keybindings: compileResolvedKeybindingsConfig([
        { key: "ctrl+n", command: "composer.sendBackground" },
      ]),
    });
    expect(handle(keyboardEvent("n", { ctrlKey: true }))).toBe(true);
    expect(input.activeComposerMenuItemRef.current?.id).toBe("first");
    expect(input.submitComposer).not.toHaveBeenCalled();
  });

  it.each([
    ["n", "ArrowDown"],
    ["p", "ArrowUp"],
  ])("routes Control+%s through %s navigation", (key, arrow) => {
    const { input, handle } = menuHandler();
    expect(handle(keyboardEvent(key, { ctrlKey: true }))).toBe(true);
    expect(input.activeComposerMenuItemRef.current?.id).toBe(key === "n" ? "first" : "second");
    const arrows = menuHandler();
    expect(arrows.handle(keyboardEvent(arrow))).toBe(true);
    expect(input.activeComposerMenuItemRef.current).toEqual(
      arrows.input.activeComposerMenuItemRef.current,
    );
    expect(handle(keyboardEvent(key, { ctrlKey: true }))).toBe(true);
    expect(input.activeComposerMenuItemRef.current?.id).toBe(key === "n" ? "second" : "first");
    expect(handle(keyboardEvent(key, { ctrlKey: true }))).toBe(true);
    const selected = input.activeComposerMenuItemRef.current;
    expect(selected?.id).toBe(key === "n" ? "first" : "second");
    expect(handle(keyboardEvent("Enter"))).toBe(true);
    expect(input.onSelectComposerItem).toHaveBeenCalledExactlyOnceWith(selected);
    expect(input.submitComposer).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { metaKey: true },
    { ctrlKey: true, metaKey: true },
    { ctrlKey: true, altKey: true },
    { ctrlKey: true, shiftKey: true },
    { ctrlKey: true, isComposing: true },
    { ctrlKey: true, keyCode: 229 },
  ])("leaves text and other chords untouched: %j", (modifiers) => {
    const { input, handle } = menuHandler();
    for (const key of ["n", "p"]) {
      expect(handle(keyboardEvent(key, modifiers))).toBe(false);
    }
    expect(input.activeComposerMenuItemRef.current).toBeNull();
  });

  it("leaves Control+N/P alone outside the menu and without selectable results", () => {
    const { input, handle } = menuHandler();
    input.composerMenuOpenRef.current = false;
    expect(handle(keyboardEvent("n", { ctrlKey: true }))).toBe(false);
    input.composerMenuOpenRef.current = true;
    input.composerMenuItemsRef.current = [];
    expect(handle(keyboardEvent("p", { ctrlKey: true }))).toBe(false);
    const literal = menuHandler({ isLiteralPendingAnswer: true });
    expect(literal.handle(keyboardEvent("n", { ctrlKey: true }))).toBe(false);
    expect(input.activeComposerMenuItemRef.current).toBeNull();
    expect(literal.input.activeComposerMenuItemRef.current).toBeNull();
  });
});
