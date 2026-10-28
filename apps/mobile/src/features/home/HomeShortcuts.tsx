import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { RowPressable } from "../../components/ui/RowPressable";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { cn } from "../../lib/cn";
import { appAtomRegistry } from "../../state/atom-registry";
import { createHomeShortcutsAtom } from "../../state/home-shortcuts";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { workspaceConnections } from "../../state/workspace";

const homeShortcutsAtom = createHomeShortcutsAtom({
  environmentsAtom: workspaceConnections.environmentsAtom,
  settingsValueAtom: serverEnvironment.settingsValueAtom,
  threadShellAtom: environmentThreadShells.threadShellAtom,
});

export function HomeShortcuts(props: {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedThreadKey: string | null;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const shortcuts = useAtomValue(homeShortcutsAtom);
  return (
    <View>
      {shortcuts
        .filter(
          ({ thread }) =>
            props.selectedEnvironmentId === null ||
            thread.environmentId === props.selectedEnvironmentId,
        )
        .map(({ label, thread }) => {
          const key = scopedThreadKey(thread.environmentId, thread.id);
          const selected = props.selectedThreadKey === key;
          return (
            <RowPressable
              key={key}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected }}
              className={cn(
                "min-h-12 flex-row items-center gap-3 rounded-xl px-4 py-3",
                selected && "bg-row-hover",
              )}
              onPress={() => {
                const current = appAtomRegistry
                  .get(homeShortcutsAtom)
                  .find(
                    (candidate) =>
                      candidate.thread.environmentId === thread.environmentId &&
                      candidate.thread.id === thread.id,
                  );
                if (current) props.onSelectThread(current.thread);
              }}
            >
              <SymbolView name="house" size={20} tintColorClassName="accent-icon" />
              <AppText textRole="body" className="flex-1 text-foreground" numberOfLines={1}>
                {label}
              </AppText>
            </RowPressable>
          );
        })}
    </View>
  );
}
