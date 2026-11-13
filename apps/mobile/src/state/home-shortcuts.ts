import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentConnectionSummary } from "@t3tools/client-runtime/state/presentation";
import type { EnvironmentId, ScopedThreadRef, ServerSettings } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

export type HomeShortcutEnvironment = Pick<
  EnvironmentConnectionSummary,
  "environmentId" | "environmentLabel" | "isEnabled" | "connectionState"
>;

export function createHomeShortcutsAtom(input: {
  readonly environmentsAtom: Atom.Atom<readonly HomeShortcutEnvironment[]>;
  readonly settingsValueAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<Pick<ServerSettings, "home"> | null>;
  readonly threadShellAtom: (ref: ScopedThreadRef) => Atom.Atom<EnvironmentThreadShell | null>;
}) {
  return Atom.make((get) => {
    const homes = get(input.environmentsAtom).flatMap((environment) => {
      if (!environment.isEnabled || environment.connectionState !== "connected") return [];
      const threadId = get(input.settingsValueAtom(environment.environmentId))?.home.threadId;
      if (!threadId) return [];
      const thread = get(
        input.threadShellAtom({ environmentId: environment.environmentId, threadId }),
      );
      if (!thread || thread.archivedAt !== null) return [];
      return [{ environment, thread }];
    });
    return homes.map(({ environment, thread }) => ({
      label: homes.length > 1 ? `Home · ${environment.environmentLabel}` : "Home",
      thread,
    }));
  }).pipe(Atom.withLabel("mobile:home-shortcuts"));
}

/**
 * The thread list leaves each environment's current Home thread to the Home
 * shortcuts. Older Home threads stay in history, as on web.
 */
export function createListThreadShellsAtom(input: {
  readonly threadsAtom: Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>;
  readonly settingsValueAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<Pick<ServerSettings, "home"> | null>;
}) {
  return Atom.make((get) => {
    const threads = get(input.threadsAtom);
    const homeThreadIdByEnvironment = new Map<EnvironmentId, string | null>();
    const homeThreadIdOf = (environmentId: EnvironmentId) => {
      if (!homeThreadIdByEnvironment.has(environmentId)) {
        homeThreadIdByEnvironment.set(
          environmentId,
          get(input.settingsValueAtom(environmentId))?.home.threadId ?? null,
        );
      }
      return homeThreadIdByEnvironment.get(environmentId);
    };
    const listed = threads.filter((thread) => homeThreadIdOf(thread.environmentId) !== thread.id);
    // Keep the source array when nothing is hidden, so its identity checks still hold.
    return listed.length === threads.length ? threads : listed;
  }).pipe(Atom.withLabel("mobile:list-thread-shells"));
}
