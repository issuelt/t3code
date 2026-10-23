"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  CheckCircle2Icon,
  CopyIcon,
  ExternalLinkIcon,
  LoaderIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { type EnvironmentId, type ProviderInstanceId } from "@t3tools/contracts";
import { EMPTY_PROVIDER_LOGIN_STATE } from "@t3tools/client-runtime/state/provider-login";

import { providerLoginEnvironment } from "../../state/providerLogin";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useStableCallback } from "../../hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

interface ProviderLoginDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly providerName: string;
  readonly isAuthenticated: boolean;
}

function themeFromElement(element: HTMLElement): ITheme {
  const styles = window.getComputedStyle(element);
  const background = styles.backgroundColor;
  const foreground = styles.color;
  return {
    background: background && background !== "rgba(0, 0, 0, 0)" ? background : "#0b0b0c",
    foreground: foreground || "#e5e5e5",
    cursor: foreground || "#e5e5e5",
  };
}

/**
 * A real interactive login terminal: the login CLI (codex device-auth /
 * claude setup-token) needs stdin (press a key, paste a token), so the dialog
 * hosts a full xterm surface wired to the additive `providerLogin.*` WS
 * methods. The first verification URL and device code parsed from the stream
 * are surfaced prominently above the raw output.
 */
export function ProviderLoginDialog({
  open,
  onOpenChange,
  environmentId,
  instanceId,
  providerName,
  isAuthenticated,
}: ProviderLoginDialogProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const writtenLengthRef = useRef(0);

  const login = useEnvironmentQuery(
    open ? providerLoginEnvironment.attach({ environmentId, input: { instanceId } }) : null,
  );
  const state = login.data ?? EMPTY_PROVIDER_LOGIN_STATE;

  // Latest accumulated output, readable from the terminal-creation effect
  // without making `state.output` a dependency of it (which would tear down and
  // recreate the terminal on every streamed byte).
  const outputRef = useRef(state.output);
  useLayoutEffect(() => {
    outputRef.current = state.output;
  }, [state.output]);

  const write = useStableCallback(
    useAtomCommand(providerLoginEnvironment.write, { reportFailure: false }),
  );
  const resize = useStableCallback(
    useAtomCommand(providerLoginEnvironment.resize, { reportFailure: false }),
  );
  const cancel = useAtomCommand(providerLoginEnvironment.cancel, { reportFailure: false });

  const { copyToClipboard } = useCopyToClipboard();

  const succeeded =
    isAuthenticated ||
    (state.status === "exited" && (state.exitCode === 0 || state.exitCode === null));
  const failed = state.status === "error" || (state.status === "exited" && !succeeded);

  const closeAndCancel = (nextOpen: boolean) => {
    if (!nextOpen) {
      void cancel({ environmentId, input: { instanceId } });
    }
    onOpenChange(nextOpen);
  };

  // Create the xterm surface when the dialog opens; tear it down on close.
  useEffect(() => {
    if (!open) return;
    const mount = containerRef.current;
    if (!mount) return;

    const fitAddon = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      scrollback: 5_000,
      convertEol: true,
      fontFamily:
        '"SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace',
      theme: themeFromElement(mount),
    });
    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Flush whatever output already accumulated before this terminal existed.
    // The write effect below only reacts to *changes* in `state.output`; the
    // login CLIs (codex device-auth / claude setup-token) emit their URL and
    // prompts in an initial burst and then go quiet while the user authorizes,
    // so any output that landed before the terminal was created (buffered
    // snapshot replay on attach, a re-open, or a StrictMode remount) would
    // otherwise never be painted, leaving the pane blank the whole time.
    const initialOutput = outputRef.current;
    if (initialOutput.length > 0) {
      terminal.write(initialOutput);
    }
    writtenLengthRef.current = initialOutput.length;

    const inputDisposable = terminal.onData((data) => {
      void write({ environmentId, input: { instanceId, data } });
    });

    // Fit once layout has settled: the dialog animates in (scale/opacity), so a
    // synchronous fit here can size the PTY against an unmeasured surface.
    let fitFrame = 0;
    const applyFit = () => {
      const activeTerminal = terminalRef.current;
      const activeFit = fitAddonRef.current;
      if (!activeTerminal || !activeFit) return;
      try {
        activeFit.fit();
      } catch {
        // ignore transient fit failures before layout settles
      }
      void resize({
        environmentId,
        input: { instanceId, cols: activeTerminal.cols, rows: activeTerminal.rows },
      });
    };
    fitFrame = requestAnimationFrame(applyFit);

    const stopObservingResize = observeResize(mount, () => {
      const activeTerminal = terminalRef.current;
      const activeFit = fitAddonRef.current;
      if (!activeTerminal || !activeFit) return;
      try {
        activeFit.fit();
      } catch {
        return;
      }
      void resize({
        environmentId,
        input: { instanceId, cols: activeTerminal.cols, rows: activeTerminal.rows },
      });
    });

    return () => {
      if (fitFrame !== 0) {
        cancelAnimationFrame(fitFrame);
      }
      stopObservingResize();
      inputDisposable.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
    };
  }, [open, environmentId, instanceId, write, resize]);

  // Write output deltas to the terminal as they stream in.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const output = state.output;
    const previousLength = writtenLengthRef.current;
    if (output.length >= previousLength) {
      terminal.write(output.slice(previousLength));
    } else {
      // Buffer diverged (e.g. re-attach): reset and rewrite.
      terminal.reset();
      terminal.write(output);
    }
    writtenLengthRef.current = output.length;
  }, [state.output]);

  const statusLabel = succeeded
    ? "Authenticated"
    : failed
      ? "Login did not complete"
      : state.status === "running"
        ? "Waiting for you to authorize…"
        : "Starting login…";

  return (
    <Dialog open={open} onOpenChange={closeAndCancel}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Log in to {providerName}</DialogTitle>
          <DialogDescription>
            Complete the sign-in below. Open the verification link in your browser, then follow the
            prompts here.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div
            className={
              "flex items-center gap-2 rounded-md border px-3 py-2 text-xs " +
              (succeeded
                ? "border-success/40 text-success"
                : failed
                  ? "border-destructive/40 text-destructive"
                  : "border-border/60 text-muted-foreground")
            }
          >
            {succeeded ? (
              <CheckCircle2Icon className="size-4 shrink-0" />
            ) : failed ? (
              <TriangleAlertIcon className="size-4 shrink-0" />
            ) : (
              <LoaderIcon className="size-4 shrink-0 animate-spin" />
            )}
            <span>{statusLabel}</span>
          </div>

          {state.url && !succeeded ? (
            <div className="flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-muted/40 px-2 py-1.5">
              <a
                href={state.url}
                target="_blank"
                rel="noreferrer noopener"
                className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-mono text-xs text-primary hover:underline"
              >
                <ExternalLinkIcon className="size-3.5 shrink-0" />
                <span className="truncate">{state.url}</span>
              </a>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="size-6 shrink-0"
                aria-label="Copy verification URL"
                onClick={() => copyToClipboard(state.url ?? "", undefined)}
              >
                <CopyIcon className="size-3" />
              </Button>
            </div>
          ) : null}

          {state.code && !succeeded ? (
            <div className="flex items-center gap-2 rounded-md border border-border/70 bg-muted/40 px-3 py-1.5">
              <span className="text-xs text-muted-foreground">Enter this code:</span>
              <code className="font-mono text-sm font-semibold tracking-widest text-foreground">
                {state.code}
              </code>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="size-6 shrink-0"
                aria-label="Copy device code"
                onClick={() => copyToClipboard(state.code ?? "", undefined)}
              >
                <CopyIcon className="size-3" />
              </Button>
            </div>
          ) : null}

          <div
            ref={containerRef}
            className="h-64 w-full overflow-hidden rounded-md border border-border/60 p-2"
            style={{ backgroundColor: "#0b0b0c" }}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => closeAndCancel(false)}>
            {succeeded ? "Close" : "Cancel"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
