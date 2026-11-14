import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import {
  dispatchCommandPalette,
  useCommandPaletteMount,
  useCommandPaletteStore,
} from "../commandPaletteStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { installCommandPaletteCommands } from "./commandPaletteCommands";

const hasFleetChiefsAtom = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return Atom.make(false).pipe(Atom.keepAlive);
});
vi.mock("../state/fleet", () => ({ hasFleetChiefsAtom }));

const keybindings = compileResolvedKeybindingsConfig([
  { key: "mod+k", command: "commandPalette.toggle" },
  { key: "mod+shift+9", command: "fleet.open" },
]);

function MountedPalette() {
  useCommandPaletteMount();
  return null;
}

function setup() {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  appAtomRegistry.set(hasFleetChiefsAtom, false);
}

describe("command palette shortcuts", () => {
  it("stay inert on routes without the palette", async () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using screen = await render(null, { router: "/pair" });
    using commands = new DisposableStack();
    commands.defer(
      installCommandPaletteCommands(screen.router!, { keybindings: () => keybindings }),
    );

    await userEvent.keyboard("{Control>}k{/Control}");

    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it("open the palette while it is mounted, and it closes when it unmounts", async () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using screen = await render(<MountedPalette />, { router: "/" });
    using commands = new DisposableStack();
    commands.defer(
      installCommandPaletteCommands(screen.router!, { keybindings: () => keybindings }),
    );

    await userEvent.keyboard("{Control>}k{/Control}");
    expect(useCommandPaletteStore.getState().open).toBe(true);

    await screen.rerender(<div />);
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it("open the Fleet board only while it has a chief of staff", async () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using screen = await render(<MountedPalette />, { router: "/" });
    using commands = new DisposableStack();
    commands.defer(
      installCommandPaletteCommands(screen.router!, { keybindings: () => keybindings }),
    );

    await userEvent.keyboard("{Control>}{Shift>}9{/Shift}{/Control}");
    expect(screen.router!.state.location.pathname).toBe("/");

    appAtomRegistry.set(hasFleetChiefsAtom, true);
    await userEvent.keyboard("{Control>}{Shift>}9{/Shift}{/Control}");
    await vi.waitFor(() => expect(screen.router!.state.location.pathname).toBe("/fleet"));
  });

  it("keep a child search open on a composing Escape", async () => {
    setup();
    await using screen = await render(
      <>
        <MountedPalette />
        <input aria-label="Search files" />
      </>,
      { router: "/" },
    );
    using commands = new DisposableStack();
    commands.defer(
      installCommandPaletteCommands(screen.router!, { keybindings: () => keybindings }),
    );
    dispatchCommandPalette({ _tag: "ToggleMode", mode: "files" });
    const input = page.getByRole("textbox", { name: "Search files" });
    await input.fill("にほん");

    for (const composition of [
      { key: "Escape", isComposing: true, keyCode: 27 },
      { key: "Escape", isComposing: false, keyCode: 229 },
    ]) {
      const event = new KeyboardEvent("keydown", {
        ...composition,
        bubbles: true,
        cancelable: true,
      });
      input.element().dispatchEvent(event);
      expect(event.defaultPrevented, JSON.stringify(composition)).toBe(false);
      expect(useCommandPaletteStore.getState()).toMatchObject({ open: true, mode: "files" });
      await expect.element(input).toHaveValue("にほん");
      await expect.element(input).toHaveFocus();
    }

    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      keyCode: 27,
      bubbles: true,
      cancelable: true,
    });
    input.element().dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
  });
});

describe("openCommandPalette", () => {
  it("drops a request made while no palette is mounted", async () => {
    setup();
    await using screen = await render(null, { router: "/pair" });

    openCommandPalette({ open: "new-thread-in" });
    await screen.rerender(<MountedPalette />);
    expect(useCommandPaletteStore.getState()).toMatchObject({ open: false, openIntent: null });

    openCommandPalette({ open: "new-thread-in" });
    expect(useCommandPaletteStore.getState()).toMatchObject({
      open: true,
      openIntent: { kind: "new-thread-in" },
    });
  });
});
