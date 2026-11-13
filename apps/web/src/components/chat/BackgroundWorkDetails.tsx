import { matchBackgroundTaskItem } from "@t3tools/client-runtime/state/thread-execution";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useNowSecond } from "~/hooks/useNowSecond";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { CommandOutputPanel, useCommandOutputStreaming } from "./CommandOutputPanel";
import { ShellCommandBlock } from "./ShellCommandBlock";
import { WorkLogButton } from "./WorkLog";

type BackgroundWorkDetailsProps = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly onOpenThread: (threadId: ThreadId) => void;
};

function LiveElapsed({ startedAt }: { startedAt: number }) {
  const now = useNowSecond();
  return <>{formatDuration(Math.max(0, now - startedAt))}</>;
}

function BackgroundWorkTask(
  props: Omit<BackgroundWorkDetailsProps, "tasks"> & {
    readonly task: OrchestrationV2PendingBackgroundTask;
  },
) {
  const { task } = props;
  const [expanded, setExpanded] = useState(task.awaited === true);
  const [showCommand, setShowCommand] = useState(false);
  const [fullOutput, setFullOutput] = useState(false);
  const streamsOutput = useCommandOutputStreaming(props.environmentId);
  const item = matchBackgroundTaskItem(task, props.turnItems);
  const command = task.command ?? (item?.type === "command_execution" ? item.input : undefined);
  const title =
    task.description?.trim() || item?.title || command || task.kind.replaceAll("_", " ");
  const childThreadId = task.kind === "subagent" ? task.childThreadId : undefined;
  const startedAt = item?.startedAt ? DateTime.toEpochMillis(item.startedAt) : null;
  const completedAt = item?.completedAt ? DateTime.toEpochMillis(item.completedAt) : null;
  const running = item === undefined || item.status === "running";
  const hasOutput = task.kind !== "subagent" && item?.type === "command_execution" && streamsOutput;
  return (
    <section className="min-w-0">
      <WorkLogButton
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        icon={
          <span className="text-icon-muted">
            {running ? (
              <Spinner size="md" />
            ) : item?.status === "failed" ? (
              <XIcon aria-hidden className="size-4" />
            ) : (
              <CheckIcon aria-hidden className="size-4" />
            )}
          </span>
        }
        label={<span className="text-foreground">{title}</span>}
        trailing={
          <>
            {task.awaited ? (
              <Badge variant="outline" size="sm">
                waiting
              </Badge>
            ) : null}
            {startedAt !== null ? (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {running ? (
                  <LiveElapsed startedAt={startedAt} />
                ) : completedAt !== null ? (
                  formatDuration(Math.max(0, completedAt - startedAt))
                ) : null}
              </span>
            ) : null}
            {expanded ? (
              <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
            ) : (
              <ChevronRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
            )}
          </>
        }
      />
      {expanded ? (
        <div className="mt-1 space-y-1">
          {hasOutput ? (
            <div
              className={
                fullOutput
                  ? "mb-1 ml-8 rounded-md border border-border bg-code px-2.5 py-1.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-words"
                  : undefined
              }
            >
              <CommandOutputPanel
                environmentId={props.environmentId}
                threadId={task.sourceThreadId ?? item.threadId ?? props.threadId}
                itemId={item.id}
                mode={fullOutput ? "full" : "tail"}
              />
            </div>
          ) : null}
          {task.kind !== "subagent" && command && showCommand ? (
            <div className="ml-8 rounded-md border border-border bg-code px-2.5 py-1.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-words">
              <ShellCommandBlock command={command} />
            </div>
          ) : null}
          <div className="mb-2 ml-6 flex flex-wrap gap-1">
            {task.kind !== "subagent" && command ? (
              <Button
                variant="ghost-muted"
                size="xs"
                aria-expanded={showCommand}
                onClick={() => setShowCommand(!showCommand)}
              >
                {showCommand ? "Hide command" : "Show command"}
              </Button>
            ) : null}
            {hasOutput ? (
              <Button
                variant="ghost-muted"
                size="xs"
                aria-pressed={fullOutput}
                onClick={() => setFullOutput(!fullOutput)}
              >
                {fullOutput ? "Last lines" : "Full output"}
              </Button>
            ) : null}
            {childThreadId ? (
              <Button
                variant="ghost-muted"
                size="xs"
                onClick={() => props.onOpenThread(childThreadId)}
              >
                Open thread
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function BackgroundWorkDetails(props: BackgroundWorkDetailsProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<InlineButton />}>Details</DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Background work</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {open ? (
            <div className="space-y-1">
              {props.tasks.map((task) => (
                <BackgroundWorkTask
                  key={task.taskId}
                  {...props}
                  task={task}
                  onOpenThread={(threadId) => {
                    setOpen(false);
                    props.onOpenThread(threadId);
                  }}
                />
              ))}
            </div>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
