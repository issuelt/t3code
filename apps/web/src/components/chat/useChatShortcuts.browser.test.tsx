import { useEffect } from "react";
import { expect, it, vi } from "vite-plus/test";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { userEvent } from "vite-plus/test/browser";

import { surfaceShortcutKey } from "~/lib/surfaceShortcutKey";
import { render } from "../../../test/render";
import type { ChatComposerHandle } from "./ChatComposer";
import { useChatShortcuts } from "./useChatShortcuts";

const shortcutContext = {
  terminalFocus: false,
  terminalOpen: false,
  previewFocus: false,
  previewOpen: false,
  isWeb: true,
  isDesktop: false,
  modelPickerOpen: false,
};

const focusOnMount = (element: HTMLElement | null) => element?.focus();

// Stands in for the right panel's launcher, which needs the whole app around it. Like the
// real one it takes focus, advertises its letters in `data-surface-launcher-keys`, and
// claims one from its own window capture listener unless the key was already handled.
function Launcher(props: { keys: string; received: string[] }) {
  useEffect(() => {
    const claim = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const key = surfaceShortcutKey(event);
      if (key === null || !props.keys.toLowerCase().includes(key)) return;
      event.preventDefault();
      props.received.push(event.key);
    };
    window.addEventListener("keydown", claim, true);
    return () => window.removeEventListener("keydown", claim, true);
  }, [props.keys, props.received]);
  return (
    <div
      ref={focusOnMount}
      tabIndex={0}
      aria-label="Open a surface"
      data-surface-launcher-keys={props.keys}
    />
  );
}

// The chat's shortcut listener registers when the chat mounts, so a launcher that opens
// later registers after it. Tests mount the chat first and add the launcher by rerendering.
function Chat(props: {
  composerKeys: string[];
  launcher?: { keys: string; received: string[] };
  menu?: { open: boolean; navigated: () => void; filePicker: () => void };
}) {
  useChatShortcuts({
    enabled: true,
    keybindings: props.menu
      ? compileResolvedKeybindingsConfig([{ key: "ctrl+p", command: "filePicker.toggle" }])
      : [],
    scriptKeybindings: [],
    getShortcutContext: () => ({ ...shortcutContext, composerFocus: props.menu !== undefined }),
    threadFindActive: false,
    composerRef: {
      current: {
        handleMenuNavigationKey: (event: KeyboardEvent) => {
          if (!props.menu?.open || event.key !== "p" || !event.ctrlKey) return false;
          props.menu.navigated();
          return true;
        },
        insertTextAtEnd: (key: string) => {
          props.composerKeys.push(key);
          return true;
        },
      } as Partial<ChatComposerHandle> as ChatComposerHandle,
    },
    branchToolbarRef: { current: null },
    closeThreadFind: () => {},
    commands: props.menu ? { "filePicker.toggle": () => props.menu?.filePicker() } : {},
    fallback: () => undefined,
  });
  return props.launcher ? <Launcher {...props.launcher} /> : null;
}

// router: false because the chat shortcuts and the launcher stand-in never navigate.
const options = { router: false } as const;

it("leaves the launcher's letters to the launcher, in either case", async () => {
  const composerKeys: string[] = [];
  const received: string[] = [];
  await using screen = await render(<Chat composerKeys={composerKeys} />, options);
  await screen.rerender(<Chat composerKeys={composerKeys} launcher={{ keys: "BT", received }} />);

  await userEvent.keyboard("tT");

  expect(received).toEqual(["t", "T"]);
  expect(composerKeys).toEqual([]);
});

it("still types other letters into the composer while the launcher is open", async () => {
  const composerKeys: string[] = [];
  const received: string[] = [];
  await using screen = await render(<Chat composerKeys={composerKeys} />, options);
  await screen.rerender(<Chat composerKeys={composerKeys} launcher={{ keys: "BT", received }} />);

  await userEvent.keyboard("a");

  expect(composerKeys).toEqual(["a"]);
  expect(received).toEqual([]);
});

it("gives composer menu navigation priority over global Control+P only while handled", async () => {
  const navigated = vi.fn();
  const filePicker = vi.fn();
  await using screen = await render(
    <Chat composerKeys={[]} menu={{ open: true, navigated, filePicker }} />,
    options,
  );
  const press = () => {
    const event = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  };
  press();
  expect(navigated).toHaveBeenCalledTimes(1);
  expect(filePicker).not.toHaveBeenCalled();
  await screen.rerender(<Chat composerKeys={[]} menu={{ open: false, navigated, filePicker }} />);
  press();
  expect(navigated).toHaveBeenCalledTimes(1);
  expect(filePicker).toHaveBeenCalledTimes(1);
});

it("leaves a non-Latin launcher letter to the launcher by its physical key", async () => {
  const composerKeys: string[] = [];
  const received: string[] = [];
  await using screen = await render(<Chat composerKeys={composerKeys} />, options);
  await screen.rerender(<Chat composerKeys={composerKeys} launcher={{ keys: "BT", received }} />);

  // Playwright cannot press a key its US layout lacks, so send what a Ukrainian T key sends.
  const event = new KeyboardEvent("keydown", {
    key: "\u0435",
    code: "KeyT",
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);

  expect(composerKeys).toEqual([]);
  expect(received).toEqual(["\u0435"]);
});

it.each([
  { key: "b", code: "KeyN", composer: [], launcher: ["b"] },
  { key: "x", code: "KeyB", composer: ["x"], launcher: [] },
  { key: "è", code: "KeyT", composer: ["è"], launcher: [] },
])("routes $key on $code by the typed letter", async ({ key, code, composer, launcher }) => {
  const composerKeys: string[] = [];
  const received: string[] = [];
  await using screen = await render(<Chat composerKeys={composerKeys} />, options);
  await screen.rerender(<Chat composerKeys={composerKeys} launcher={{ keys: "BT", received }} />);

  const event = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(event);

  expect(composerKeys).toEqual(composer);
  expect(received).toEqual(launcher);
});
