import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { matchBackgroundTaskItem } from "@t3tools/client-runtime/state/thread-execution";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { Button } from "../../components/ui/Button";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { ThreadCommandOutput, useCommandOutputStreaming } from "./thread-command-output";
import { useVisibleSecondClock } from "./use-visible-second-clock";

const KIND_LABELS = {
  subagent: "Subagent",
  command: "Command",
  monitor: "Monitor",
  background_task: "Background task",
} as const;

type BackgroundWorkTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

export function ThreadBackgroundWorkSheet({ route }: StaticScreenProps<BackgroundWorkTarget>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const target = route.params;
  const ref = scopeThreadRef(target.environmentId, target.threadId);
  const thread = useAtomValue(environmentThreadShells.threadShellAtom(ref));
  const detail = useAtomValue(environmentThreadDetails.quietThreadAtom(ref));
  const tasks = thread?.pendingBackgroundTasks ?? [];
  const { themeAppearance } = useAppearancePreferences();
  const openThread = (threadId: ThreadId) => {
    void Haptics.selectionAsync();
    // A thread replaces the leaf sheet so workspace back navigation still works.
    navigation.dispatch(
      StackActions.replace("Thread", { environmentId: target.environmentId, threadId }),
    );
  };
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader title="Background work" onClose={() => navigation.goBack()} />
      <ScreenContent>
        <ScrollView
          nestedScrollEnabled
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="px-5 pb-6"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          {tasks.length === 0 ? (
            <Text className="pt-6 text-center text-sm text-foreground-muted">
              Nothing running in the background.
            </Text>
          ) : (
            tasks.map((task) => (
              <BackgroundWorkRow
                key={task.taskId}
                task={task}
                item={matchBackgroundTaskItem(task, detail?.projection.turnItems ?? [])}
                environmentId={target.environmentId}
                themeAppearance={themeAppearance}
                onOpen={openThread}
              />
            ))
          )}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}

function LiveElapsed({ startedAt }: { readonly startedAt: number }) {
  const now = useVisibleSecondClock(true);
  return (
    <Text className="text-xs tabular-nums text-foreground-muted">
      {formatDuration(Math.max(0, now - startedAt))}
    </Text>
  );
}

function BackgroundWorkRow(props: {
  readonly environmentId: EnvironmentId;
  readonly task: OrchestrationV2PendingBackgroundTask;
  readonly item: ThreadStructure["turnItems"][number] | undefined;
  readonly themeAppearance: "light" | "dark";
  readonly onOpen: (threadId: ThreadId) => void;
}) {
  const { task, item } = props;
  const [expanded, setExpanded] = useState(task.awaited === true);
  const [showCommand, setShowCommand] = useState(false);
  const [fullOutput, setFullOutput] = useState(false);
  const streamsOutput = useCommandOutputStreaming(props.environmentId);
  const command = task.command ?? (item?.type === "command_execution" ? item.input : undefined);
  const title = task.description?.trim() || item?.title || command || KIND_LABELS[task.kind];
  const childThreadId = task.kind === "subagent" ? task.childThreadId : undefined;
  const startedAt = item?.startedAt ? DateTime.toEpochMillis(item.startedAt) : null;
  const completedAt = item?.completedAt ? DateTime.toEpochMillis(item.completedAt) : null;
  const running = item === undefined || item.status === "running";
  const hasOutput = task.kind !== "subagent" && item?.type === "command_execution" && streamsOutput;
  return (
    <View className="border-b border-border py-1">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="min-h-11 flex-row items-center gap-2 active:opacity-70"
      >
        <View className="w-6 items-center">
          {running ? (
            <AppActivityIndicator size="small" colorClassName="accent-foreground-muted" />
          ) : (
            <SymbolView
              name={item?.status === "failed" ? "xmark" : "checkmark"}
              size={15}
              tintColorClassName="accent-foreground-muted"
            />
          )}
        </View>
        <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-foreground">
          {title}
        </Text>
        {task.awaited ? (
          <View className="rounded border border-border px-1">
            <Text className="text-2xs text-foreground-muted">waiting</Text>
          </View>
        ) : null}
        {startedAt !== null ? (
          running ? (
            <LiveElapsed startedAt={startedAt} />
          ) : completedAt !== null ? (
            <Text className="text-xs tabular-nums text-foreground-muted">
              {formatDuration(Math.max(0, completedAt - startedAt))}
            </Text>
          ) : null
        ) : null}
        <SymbolView
          name={expanded ? "chevron.down" : "chevron.right"}
          size={12}
          tintColorClassName="accent-icon-subtle"
        />
      </Pressable>
      {expanded ? (
        <View className="ml-8 gap-1 pb-1">
          {hasOutput ? (
            <ThreadCommandOutput
              environmentId={props.environmentId}
              threadId={task.sourceThreadId ?? item.threadId}
              itemId={item.id}
              themeAppearance={props.themeAppearance}
              mode={fullOutput ? "full" : "tail"}
            />
          ) : null}
          {task.kind !== "subagent" && command && showCommand ? (
            <View className="rounded-md border border-border bg-subtle px-2.5 py-1.5">
              <Text selectable className="font-mono text-2xs leading-normal text-foreground">
                {command}
              </Text>
            </View>
          ) : null}
          <View className="flex-row flex-wrap">
            {task.kind !== "subagent" && command ? (
              <Button
                label={showCommand ? "Hide command" : "Show command"}
                tone="text"
                size="compact"
                onPress={() => setShowCommand(!showCommand)}
              />
            ) : null}
            {hasOutput ? (
              <Button
                label={fullOutput ? "Last lines" : "Full output"}
                tone="text"
                size="compact"
                onPress={() => setFullOutput(!fullOutput)}
              />
            ) : null}
            {childThreadId ? (
              <Button
                label="Open thread"
                tone="text"
                size="compact"
                onPress={() => props.onOpen(childThreadId)}
              />
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}
