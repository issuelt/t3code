import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverCreateHandle: () => ({}),
}));
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../rightPanelStore", () => ({
  selectThreadPanelOpen: (_: unknown, __: unknown, presentation: string) =>
    presentation === "inline",
  useRightPanelStore: Object.assign(
    (select: (state: { threadPanelVisibilityByThreadKey: object }) => unknown) =>
      select({ threadPanelVisibilityByThreadKey: {} }),
    { getState: () => ({ setThreadPanelOpen: vi.fn() }) },
  ),
}));

import { ChatCanvasContext } from "./ChatCanvasContext";
import { ThreadDetailsCard } from "./ThreadDetailsCard";

const canvas = {
  container: { width: 1584, height: 700 },
  lane: { padding: 20, minChatWidth: 640 },
  layout: {
    chat: { left: 424, width: 736 },
    frame: { x: 1260, y: 400, width: 240, height: 288 },
    overlapsDetailsCard: true,
  },
  previewKey: null,
  reportPreview: vi.fn(),
  clearPreview: vi.fn(),
  registerTimeline: vi.fn(),
  reportDetailsCard: vi.fn(),
} as unknown as NonNullable<React.ContextType<typeof ChatCanvasContext>>;

let renderer: ReactTestRenderer;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("keeps full details when expanded content grows past an overlapping preview", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const observers: Array<() => void> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  const content = { offsetHeight: 300, closest: () => ({ offsetHeight: 0, clientHeight: 0 }) };

  await act(async () => {
    renderer = create(
      <ChatCanvasContext.Provider value={canvas}>
        <ThreadDetailsCard
          threadRef={{
            environmentId: EnvironmentId.make("environment"),
            threadId: ThreadId.make("thread"),
          }}
          anchor={{ current: null }}
          handle={{} as never}
          onPresentationChange={vi.fn()}
        >
          {(density) => (density === "full" ? <section aria-label="Lineage" /> : null)}
        </ThreadDetailsCard>
      </ChatCanvasContext.Provider>,
      { createNodeMock: () => content },
    );
  });

  content.offsetHeight = 612;
  await act(async () => observers.at(-1)?.());

  const aside = renderer.root.findByType("aside");
  expect(aside.props["data-density"]).toBe("full");
  expect(aside.props.style.maxHeight).toBeLessThanOrEqual(400 - 24);
  expect(renderer.root.findAllByProps({ "aria-label": "Lineage" })).toHaveLength(1);
});
