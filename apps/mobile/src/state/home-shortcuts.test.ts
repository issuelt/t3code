import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId, type ServerSettings } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../test-fixtures";
import { createHomeShortcutsAtom, type HomeShortcutEnvironment } from "./home-shortcuts";

const mac = EnvironmentId.make("mac");
const remote = EnvironmentId.make("remote");
const homeId = ThreadId.make("home:authoritative");

function environment(environmentId = mac): HomeShortcutEnvironment {
  return {
    environmentId,
    environmentLabel: environmentId,
    isEnabled: true,
    connectionState: "connected",
  };
}

function harness() {
  const environments = Atom.make<readonly HomeShortcutEnvironment[]>([environment()]);
  const settings = Atom.family((_id: EnvironmentId) =>
    Atom.make<Pick<ServerSettings, "home"> | null>({
      home: { threadId: homeId, watches: [], watchAll: false },
    }),
  );
  const shells = Atom.family((key: string) => {
    const [environmentId, id] = key.split("/");
    return Atom.make<EnvironmentThreadShell | null>(
      makeThreadShellFixture({
        environmentId: EnvironmentId.make(environmentId!),
        id: ThreadId.make(id!),
        title: "Renamed conversation",
      }),
    );
  });
  const shortcuts = createHomeShortcutsAtom({
    environmentsAtom: environments,
    settingsValueAtom: settings,
    threadShellAtom: (ref) => shells(`${ref.environmentId}/${ref.threadId}`),
  });
  const registry = AtomRegistry.make();
  const unmount = registry.mount(shortcuts);
  return {
    environments,
    settings,
    shells,
    shortcuts,
    registry,
    [Symbol.dispose]: () => {
      unmount();
      registry.dispose();
    },
  };
}

describe("mobile Home shortcuts", () => {
  it("opens the authoritative thread even when its title is not Home", () => {
    using h = harness();
    expect(
      h.registry.get(h.shortcuts).map(({ thread }) => [thread.environmentId, thread.id]),
    ).toEqual([[mac, homeId]]);
  });

  it("keeps identical thread IDs in different environments separate and labels both hubs", () => {
    using h = harness();
    h.registry.set(h.environments, [environment(), environment(remote)]);
    expect(
      h.registry
        .get(h.shortcuts)
        .map(({ label, thread }) => [label, thread.environmentId, thread.id]),
    ).toEqual([
      ["Home · mac", mac, homeId],
      ["Home · remote", remote, homeId],
    ]);
    const remoteHomeId = ThreadId.make("home:remote-only");
    h.registry.set(h.settings(remote), {
      home: { threadId: remoteHomeId, watches: [], watchAll: false },
    });
    expect(
      h.registry.get(h.shortcuts).map(({ thread }) => [thread.environmentId, thread.id]),
    ).toEqual([
      [mac, homeId],
      [remote, remoteHomeId],
    ]);
  });

  it("hides unconfigured, unloaded, missing and archived Home conversations", () => {
    using h = harness();
    h.registry.set(h.settings(mac), null);
    expect(h.registry.get(h.shortcuts)).toEqual([]);
    h.registry.set(h.settings(mac), { home: { threadId: null, watches: [], watchAll: false } });
    expect(h.registry.get(h.shortcuts)).toEqual([]);
    h.registry.set(h.settings(mac), { home: { threadId: homeId, watches: [], watchAll: false } });
    h.registry.set(h.shells(`${mac}/${homeId}`), null);
    expect(h.registry.get(h.shortcuts)).toEqual([]);
    h.registry.set(
      h.shells(`${mac}/${homeId}`),
      makeThreadShellFixture({
        environmentId: mac,
        id: homeId,
        archivedAt: "2026-10-28T00:00:00.000Z",
      }),
    );
    expect(h.registry.get(h.shortcuts)).toEqual([]);
  });

  it("replaces the destination on settings updates and removes it on disable or disconnect", () => {
    using h = harness();
    const replacement = ThreadId.make("home:replacement");
    h.registry.set(h.settings(mac), {
      home: { threadId: replacement, watches: [], watchAll: false },
    });
    expect(h.registry.get(h.shortcuts)[0]?.thread.id).toBe(replacement);
    h.registry.set(h.environments, [{ ...environment(), isEnabled: false }]);
    expect(h.registry.get(h.shortcuts)).toEqual([]);
    h.registry.set(h.environments, [{ ...environment(), connectionState: "reconnecting" }]);
    expect(h.registry.get(h.shortcuts)).toEqual([]);
    h.registry.set(h.environments, [environment(remote)]);
    expect(h.registry.get(h.shortcuts)[0]?.thread.environmentId).toBe(remote);
    h.registry.set(h.environments, []);
    expect(h.registry.get(h.shortcuts)).toEqual([]);
  });
});
