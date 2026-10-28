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
