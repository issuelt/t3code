import { useAtomValue } from "@effect/atom-react";
import { msg, T, useGT } from "gt-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  PeerLinkSummary,
  ScopedThreadRef,
  WorkFilesMode,
  WorkFilesSummary,
} from "@t3tools/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { formatBytes } from "~/lib/formatBytes";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { waitForThreadShell } from "~/state/entities";
import { readEnvironment } from "~/state/environments";
import { peerLinkEnvironment } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { m } from "~/i18n/messages";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { afterContinuedThreadWait, continuedThreadFollowThrough } from "./continueOnMachine.logic";
import { continueOnMachineThreadAtom } from "./continueOnMachineDialogState";

/** A new thread reaches this window over the target's own connection, which may be reconnecting. */
const CONTINUED_THREAD_WAIT_MS = 15_000;

export function ContinueOnMachineDialogHost() {
  const threadRef = useAtomValue(continueOnMachineThreadAtom);
  if (threadRef === null) return null;
  return (
    <ContinueOnMachineDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(continueOnMachineThreadAtom, null)}
    />
  );
}

type Stage =
  | { readonly kind: "pick" }
  | { readonly kind: "checking"; readonly link: PeerLinkSummary }
  | {
      readonly kind: "ask";
      readonly link: PeerLinkSummary;
      readonly summary: WorkFilesSummary;
      readonly error: null;
    }
  /** The files could not be read; continuing without them is still possible. */
  | {
      readonly kind: "ask";
      readonly link: PeerLinkSummary;
      readonly summary: null;
      readonly error: string;
    }
  | { readonly kind: "running"; readonly link: PeerLinkSummary; readonly mode: WorkFilesMode };

const failureMessage = (error: unknown) =>
  error instanceof Error ? error.message : m(msg("An unexpected error occurred."));

/** What the files are, in one sentence, with what stays behind. */
function workFilesDescription(summary: WorkFilesSummary, gt: ReturnType<typeof useGT>): string {
  const vars = {
    files: summary.fileCount,
    deletions: summary.deletionCount,
    size: formatBytes(summary.totalBytes),
    directory: summary.directory,
  };
  return summary.deletionCount === 0
    ? gt(
        "{files, plural, one {{files} file} other {{files} files}} ({size}) from {directory}. Every changed and new file goes, secrets included. Ignored files, node_modules, and build output stay on this machine.",
        vars,
      )
    : gt(
        "{files, plural, one {{files} file} other {{files} files}} and {deletions, plural, one {{deletions} deletion} other {{deletions} deletions}} ({size}) from {directory}. Every changed and new file goes, secrets included. Ignored files, node_modules, and build output stay on this machine.",
        vars,
      );
}

function ContinueOnMachineDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const router = useRouter();
  const links = useEnvironmentQuery(
    peerLinkEnvironment.list({ environmentId: threadRef.environmentId, input: {} }),
  );
  const summarize = useAtomCommand(peerLinkEnvironment.workFilesSummary, { reportFailure: false });
  const continueThread = useAtomCommand(peerLinkEnvironment.continueThread, {
    reportFailure: false,
  });
  const setEnvironmentEnabled = useAtomCommand(environmentCatalog.setEnabled, {
    reportFailure: false,
  });
  const [stage, setStage] = useState<Stage>({ kind: "pick" });
  const reachable = (links.data?.links ?? []).filter((link) => link.status === "reachable");
  const busy = stage.kind === "checking" || stage.kind === "running";

  const fail = (link: PeerLinkSummary, error: unknown) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: gt("Could not continue on {environment}", { environment: link.label }),
        description: failureMessage(error),
      }),
    );

  const run = async (link: PeerLinkSummary, mode: WorkFilesMode) => {
    // Where the user was when they asked; moving anywhere else while it runs means they moved on.
    const askedAt = router.latestLocation;
    setStage({ kind: "running", link, mode });
    const result = await continueThread({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, environmentId: link.environmentId, workFiles: mode },
    });
    onClose();
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) fail(link, squashAtomCommandFailure(result));
      return;
    }
    const continued = result.value;
    const target = scopeThreadRef(continued.environmentId, continued.threadId);
    const openThread = () =>
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(target) });
    // Opens the thread as a new local one opens, once this window's connection there has it.
    const openWhenItArrives = async (location: typeof askedAt) => {
      const arrived = await waitForThreadShell(target, CONTINUED_THREAD_WAIT_MS);
      const next = afterContinuedThreadWait({
        arrived,
        movedOn: router.latestLocation !== location,
      });
      if (next === "open") {
        openThread();
        return;
      }
      toastManager.add(
        stackedThreadToast({
          type: arrived ? "info" : "warning",
          title: arrived
            ? gt("The thread on {environment} is ready", { environment: continued.label })
            : gt("The thread on {environment} has not reached this window yet", {
                environment: continued.label,
              }),
          description: arrived
            ? gt("Open it when you're ready.")
            : gt("Check {environment} in Settings → Connections, then open it.", {
                environment: continued.label,
              }),
          actionProps: { children: gt("Open thread"), onClick: openThread },
          data: { hideCopyButton: true },
        }),
      );
    };
    const turnOnAndOpen = async () => {
      const clickedAt = router.latestLocation;
      const enabled = await setEnvironmentEnabled({
        environmentId: continued.environmentId,
        enabled: true,
      });
      if (enabled._tag === "Failure") {
        if (!isAtomCommandInterrupted(enabled)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: gt("Could not turn on {environment}", { environment: continued.label }),
              description: failureMessage(squashAtomCommandFailure(enabled)),
            }),
          );
        }
        return;
      }
      await openWhenItArrives(clickedAt);
    };
    const saved = readEnvironment(continued.environmentId);
    const followThrough = continuedThreadFollowThrough({
      saved: saved === null ? null : { enabled: saved.entry.enabled },
      linkUrls: link.urls,
    });
    const picked =
      mode === "transfer"
        ? gt("A new thread there picked up this one, with {count} work files.", {
            count: continued.transferredFiles,
          })
        : gt("A new thread there picked up this one.");
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: gt("Continued on {environment}", { environment: continued.label }),
        description:
          followThrough.kind === "open"
            ? picked
            : followThrough.kind === "turn-on"
              ? gt("{picked} Turn on {environment} here to open it.", {
                  picked,
                  environment: continued.label,
                })
              : gt("{picked} Connect this window to {environment} to open it.", {
                  picked,
                  environment: continued.label,
                }),
        ...(followThrough.kind === "turn-on"
          ? {
              actionProps: {
                children: gt("Turn on {environment}", { environment: continued.label }),
                onClick: () => void turnOnAndOpen(),
              },
            }
          : followThrough.kind === "connect"
            ? {
                actionProps: {
                  children: gt("Connect {environment}", { environment: continued.label }),
                  onClick: () =>
                    void navigate({
                      to: "/settings/connections",
                      search: followThrough.host === null ? {} : { connect: followThrough.host },
                    }),
                },
              }
            : {}),
        data: { hideCopyButton: true },
      }),
    );
    if (followThrough.kind === "open") await openWhenItArrives(askedAt);
  };

  const choose = async (link: PeerLinkSummary) => {
    setStage({ kind: "checking", link });
    const result = await summarize({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) {
        onClose();
        return;
      }
      const error = failureMessage(squashAtomCommandFailure(result));
      setStage({ kind: "ask", link, summary: null, error });
      return;
    }
    const summary = result.value;
    // Nothing to carry: there is no question to ask.
    if (summary.fileCount === 0 && summary.deletionCount === 0) {
      await run(link, "skip");
      return;
    }
    setStage({ kind: "ask", link, summary, error: null });
  };

  if (stage.kind === "ask" || (stage.kind === "running" && stage.mode === "transfer")) {
    const description =
      stage.kind !== "ask"
        ? gt("Sending the work files to {environment}…", { environment: stage.link.label })
        : stage.error !== null
          ? gt("The work files could not be read: {error}", { error: stage.error })
          : (stage.summary.refusal ?? workFilesDescription(stage.summary, gt));
    const canTransfer =
      stage.kind === "ask" && stage.error === null && stage.summary.refusal == null;
    return (
      <AlertDialog open onOpenChange={(open) => !open && !busy && onClose()}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>Transfer the current work files too?</T>
            </AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button variant="outline" disabled={busy} onClick={() => void run(stage.link, "skip")}>
              <T>Continue without files</T>
            </Button>
            <Button
              disabled={busy || !canTransfer}
              onClick={() => void run(stage.link, "transfer")}
            >
              {busy ? gt("Transferring…") : gt("Transfer files")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    );
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <T>Continue on another machine</T>
          </AlertDialogTitle>
          <AlertDialogDescription>
            {busy
              ? gt("Starting a thread on {environment}…", { environment: stage.link.label })
              : links.isPending
                ? gt("Checking your linked machines…")
                : reachable.length === 0
                  ? gt(
                      "None of this machine's linked machines answers now. Link one in Settings → Connections.",
                    )
                  : gt(
                      "A new thread there starts from this conversation, in the same repository. This thread stays as it is.",
                    )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {!busy && reachable.length > 0 ? (
          <div className="flex flex-col gap-2 px-6 pb-2">
            {reachable.map((link) => (
              <Button key={link.environmentId} variant="outline" onClick={() => void choose(link)}>
                {link.label}
              </Button>
            ))}
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
            <T>Cancel</T>
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
