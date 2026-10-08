// @effect-diagnostics anyUnknownInErrorContext:off - Provider CLI and PTY adapters expose unknown external failures at this boundary.
/**
 * ProviderLoginManager — ephemeral provider login sessions.
 *
 * Codex uses app-server's structured device-code API. Providers that only
 * expose an interactive CLI (currently Claude) run inside an isolated PTY.
 *
 * It deliberately reuses the terminal stack's low-level primitive (`PtyAdapter`)
 * and the same subscribe/buffer/attach fan-out idiom as `TerminalManager`, but
 * is intentionally NOT the thread-`TerminalManager`: login output is security
 * sensitive (verification URLs, and in-flight auth), so it is kept in a small
 * in-memory ring buffer only and is NEVER written to disk or the Effect logger.
 *
 * On PTY exit the manager re-runs the provider's health check via
 * `ProviderRegistry.refreshInstance`, which pushes the refreshed status to every
 * connected client through the existing `subscribeServerConfig` channel — so the
 * provider card flips to "authenticated" automatically.
 *
 * @module provider/ProviderLoginManager
 */
import {
  ClaudeSettings,
  CodexSettings,
  type ProviderDriverKind,
  type ProviderInstanceId,
  ProviderLoginInstanceNotFoundError,
  ProviderLoginNotRunningError,
  ProviderLoginSpawnError,
  type ProviderLoginStreamEvent,
  ProviderLoginUnsupportedDriverError,
  ProviderLoginWriteError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";

import { PtyAdapter, type PtyProcess } from "../terminal/PtyAdapter.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderRegistry } from "./ProviderRegistry.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import { materializeCodexShadowHome, resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import { makeClaudeEnvironment, resolveClaudeHomePath } from "./Drivers/ClaudeHome.ts";
import { CodexDeviceAuth } from "./CodexDeviceAuth.ts";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Cap the in-memory replay buffer so a chatty login can't grow unbounded. */
const MAX_BUFFER_BYTES = 256 * 1024;

type LoginListener = (event: ProviderLoginStreamEvent) => Effect.Effect<void>;

interface LoginSession {
  readonly instanceId: string;
  readonly driver: ProviderDriverKind;
  readonly pty: PtyProcess | undefined;
  readonly cancel: Effect.Effect<void>;
  readonly listeners: Set<LoginListener>;
  readonly buffer: ProviderLoginStreamEvent[];
  bufferBytes: number;
  exited: boolean;
}

export interface ProviderLoginStartRequest {
  readonly instanceId: ProviderInstanceId;
  readonly cols?: number | undefined;
  readonly rows?: number | undefined;
}

export interface ProviderLoginWriteRequest {
  readonly instanceId: ProviderInstanceId;
  readonly data: string;
}

export interface ProviderLoginResizeRequest {
  readonly instanceId: ProviderInstanceId;
  readonly cols: number;
  readonly rows: number;
}

export interface ProviderLoginCancelRequest {
  readonly instanceId: ProviderInstanceId;
}

export interface ProviderLoginManagerShape {
  /**
   * Ensure a login PTY exists for the instance (spawning it on first attach)
   * and subscribe `listener` to its event stream. Replays the buffered
   * snapshot (started + any output so far) before going live. Returns an
   * unsubscribe thunk.
   */
  readonly attachStream: (
    request: ProviderLoginStartRequest,
    listener: LoginListener,
  ) => Effect.Effect<
    () => void,
    | ProviderLoginInstanceNotFoundError
    | ProviderLoginUnsupportedDriverError
    | ProviderLoginSpawnError
  >;
  readonly write: (
    request: ProviderLoginWriteRequest,
  ) => Effect.Effect<void, ProviderLoginNotRunningError | ProviderLoginWriteError>;
  readonly resize: (
    request: ProviderLoginResizeRequest,
  ) => Effect.Effect<void, ProviderLoginNotRunningError | ProviderLoginWriteError>;
  readonly cancel: (request: ProviderLoginCancelRequest) => Effect.Effect<void>;
}

export class ProviderLoginManager extends Context.Service<
  ProviderLoginManager,
  ProviderLoginManagerShape
>()("t3/provider/ProviderLoginManager") {}

interface ResolvedLoginSpec {
  readonly driver: ProviderDriverKind;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly commandLabel: string;
  /** Directory that must exist before spawn (isolated home), when applicable. */
  readonly ensureHomeDir: string | undefined;
  readonly prepare: Effect.Effect<void, ProviderLoginSpawnError>;
  readonly transport: "codexDeviceAuth" | "pty";
}

const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);

const describeCause = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { readonly message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return String(cause);
};

const make = Effect.fn("ProviderLoginManager.make")(function* () {
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const ptyAdapter = yield* PtyAdapter;
  const serverSettings = yield* ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry;
  const codexDeviceAuth = yield* CodexDeviceAuth;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseEnv = process.env;
  const cwd = process.cwd();

  const sessions = new Map<string, LoginSession>();
  // Serialize get-or-spawn so two near-simultaneous attaches for the same
  // instance can never spawn two PTYs (one would leak).
  const spawnLock = yield* Semaphore.make(1);

  const appendToBuffer = (session: LoginSession, event: ProviderLoginStreamEvent): void => {
    session.buffer.push(event);
    if (event.type === "output") {
      session.bufferBytes += event.data.length;
    }
    while (session.bufferBytes > MAX_BUFFER_BYTES && session.buffer.length > 1) {
      const dropped = session.buffer.shift();
      if (dropped && dropped.type === "output") {
        session.bufferBytes -= dropped.data.length;
      }
    }
  };

  const publish = (session: LoginSession, event: ProviderLoginStreamEvent): void => {
    appendToBuffer(session, event);
    for (const listener of session.listeners) {
      runFork(listener(event).pipe(Effect.ignoreCause({ log: true })));
    }
  };

  const makeDirectory = (directory: string) =>
    fileSystem.makeDirectory(directory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderLoginSpawnError({
            instanceId: directory,
            detail: `failed to create home directory ${directory}: ${describeCause(cause)}`,
          }),
      ),
    );

  const resolveLoginSpec = (
    instanceId: ProviderInstanceId,
  ): Effect.Effect<
    ResolvedLoginSpec,
    | ProviderLoginInstanceNotFoundError
    | ProviderLoginUnsupportedDriverError
    | ProviderLoginSpawnError
  > =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderLoginSpawnError({
              instanceId,
              detail: `failed to read settings: ${describeCause(cause)}`,
            }),
        ),
      );
      const envelope = deriveProviderInstanceConfigMap(settings)[instanceId];
      if (envelope === undefined) {
        return yield* new ProviderLoginInstanceNotFoundError({ instanceId });
      }
      const driver = envelope.driver;

      if (driver === "codex") {
        const config = yield* decodeCodexSettings(envelope.config ?? {}).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderLoginSpawnError({
                instanceId,
                detail: `invalid codex config: ${describeCause(cause)}`,
              }),
          ),
        );
        const layout = yield* resolveCodexHomeLayout(config).pipe(
          Effect.provideService(Path.Path, path),
        );
        const codexHome = layout.effectiveHomePath;
        const prepare: Effect.Effect<void, ProviderLoginSpawnError> =
          layout.mode === "authOverlay"
            ? materializeCodexShadowHome(layout).pipe(
                Effect.provideService(Path.Path, path),
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.mapError(
                  (cause) =>
                    new ProviderLoginSpawnError({
                      instanceId,
                      detail: `failed to materialize codex home: ${describeCause(cause)}`,
                    }),
                ),
              )
            : codexHome
              ? makeDirectory(codexHome).pipe(Effect.asVoid)
              : Effect.void;
        const args = ["login", "--device-auth"] as const;
        return {
          driver,
          command: config.binaryPath,
          args,
          env: codexHome ? { ...baseEnv, CODEX_HOME: codexHome } : baseEnv,
          commandLabel: `${config.binaryPath} ${args.join(" ")}`,
          ensureHomeDir: codexHome,
          prepare,
          transport: "codexDeviceAuth",
        } satisfies ResolvedLoginSpec;
      }

      if (driver === "claudeAgent") {
        const config = yield* decodeClaudeSettings(envelope.config ?? {}).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderLoginSpawnError({
                instanceId,
                detail: `invalid claude config: ${describeCause(cause)}`,
              }),
          ),
        );
        const env = yield* makeClaudeEnvironment(config, baseEnv).pipe(
          Effect.provideService(Path.Path, path),
        );
        const home = yield* resolveClaudeHomePath(config).pipe(
          Effect.provideService(Path.Path, path),
        );
        const isolated = config.homePath.trim().length > 0;
        const args = ["setup-token"] as const;
        return {
          driver,
          command: config.binaryPath,
          args,
          env,
          commandLabel: `${config.binaryPath} ${args.join(" ")}`,
          ensureHomeDir: isolated ? home : undefined,
          prepare: isolated ? makeDirectory(home).pipe(Effect.asVoid) : Effect.void,
          transport: "pty",
        } satisfies ResolvedLoginSpec;
      }

      return yield* new ProviderLoginUnsupportedDriverError({ instanceId, driver });
    });

  const spawnSession = (
    request: ProviderLoginStartRequest,
  ): Effect.Effect<
    LoginSession,
    | ProviderLoginInstanceNotFoundError
    | ProviderLoginUnsupportedDriverError
    | ProviderLoginSpawnError
  > =>
    Effect.gen(function* () {
      const spec = yield* resolveLoginSpec(request.instanceId);
      yield* spec.prepare;
      if (spec.transport === "codexDeviceAuth") {
        const loginScope = yield* Scope.make();
        const closeLoginScope = Scope.close(loginScope, Exit.void).pipe(Effect.ignore);
        const auth = yield* codexDeviceAuth
          .start({ binaryPath: spec.command, cwd, env: spec.env })
          .pipe(
            Effect.provideService(Scope.Scope, loginScope),
            Effect.mapError(
              (cause) =>
                new ProviderLoginSpawnError({
                  instanceId: request.instanceId,
                  detail: describeCause(cause),
                }),
            ),
            Effect.onError(() => closeLoginScope),
          );
        const session: LoginSession = {
          instanceId: request.instanceId,
          driver: spec.driver,
          pty: undefined,
          cancel: auth.cancel.pipe(Effect.ignore, Effect.ensuring(closeLoginScope)),
          listeners: new Set(),
          buffer: [],
          bufferBytes: 0,
          exited: false,
        };
        sessions.set(request.instanceId, session);
        publish(session, {
          type: "started",
          instanceId: request.instanceId,
          driver: spec.driver,
          commandLabel: `${spec.command} app-server: account/login/start`,
        });
        publish(session, {
          type: "challenge",
          url: auth.verificationUrl,
          code: auth.userCode,
        });
        runFork(
          auth.completion.pipe(
            Effect.flatMap((completion) =>
              Effect.sync(() => {
                if (session.exited) return;
                session.exited = true;
                publish(session, {
                  type: "exited",
                  exitCode: completion.success ? 0 : 1,
                  exitSignal: null,
                });
                if (sessions.get(request.instanceId) === session) {
                  sessions.delete(request.instanceId);
                }
              }),
            ),
            Effect.andThen(
              providerRegistry
                .refreshInstance(request.instanceId)
                .pipe(Effect.ignoreCause({ log: true })),
            ),
            Effect.ensuring(closeLoginScope),
            Effect.ignoreCause({ log: true }),
          ),
        );
        return session;
      }
      const pty = yield* ptyAdapter
        .spawn({
          shell: spec.command,
          args: [...spec.args],
          cwd,
          cols: request.cols ?? DEFAULT_COLS,
          rows: request.rows ?? DEFAULT_ROWS,
          env: spec.env,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderLoginSpawnError({
                instanceId: request.instanceId,
                detail: describeCause(cause),
              }),
          ),
        );

      const session: LoginSession = {
        instanceId: request.instanceId,
        driver: spec.driver,
        pty,
        cancel: Effect.sync(() => pty.kill()),
        listeners: new Set(),
        buffer: [],
        bufferBytes: 0,
        exited: false,
      };
      sessions.set(request.instanceId, session);

      pty.onData((data) => publish(session, { type: "output", data }));
      pty.onExit((exit) => {
        if (session.exited) return;
        session.exited = true;
        publish(session, {
          type: "exited",
          exitCode: exit.exitCode,
          exitSignal: exit.signal,
        });
        if (sessions.get(request.instanceId) === session) {
          sessions.delete(request.instanceId);
        }
        // Re-probe so the provider card flips to authenticated when the login
        // succeeded. `refreshInstance` swallows unknown ids, so this is safe.
        runFork(
          providerRegistry
            .refreshInstance(request.instanceId)
            .pipe(Effect.ignoreCause({ log: true })),
        );
      });

      publish(session, {
        type: "started",
        instanceId: request.instanceId,
        driver: spec.driver,
        commandLabel: spec.commandLabel,
      });

      return session;
    });

  const ensureSession = (request: ProviderLoginStartRequest) =>
    spawnLock.withPermits(1)(
      Effect.suspend(() => {
        const existing = sessions.get(request.instanceId);
        return existing && !existing.exited ? Effect.succeed(existing) : spawnSession(request);
      }),
    );

  const attachStream: ProviderLoginManagerShape["attachStream"] = (request, listener) =>
    Effect.gen(function* () {
      const session = yield* ensureSession(request);

      // Buffer live events until the initial snapshot replay is complete, so a
      // late listener never sees an event twice or out of order.
      const pending: ProviderLoginStreamEvent[] = [];
      let live = false;
      const wrapped: LoginListener = (event) => {
        if (!live) {
          pending.push(event);
          return Effect.void;
        }
        return listener(event);
      };
      const snapshot = session.buffer.slice();
      session.listeners.add(wrapped);

      for (const event of snapshot) {
        yield* listener(event);
      }
      for (const event of pending) {
        yield* listener(event);
      }
      live = true;

      return () => {
        session.listeners.delete(wrapped);
      };
    });

  const requireRunning = (
    instanceId: ProviderInstanceId,
  ): Effect.Effect<LoginSession, ProviderLoginNotRunningError> => {
    const session = sessions.get(instanceId);
    return session && !session.exited
      ? Effect.succeed(session)
      : Effect.fail(new ProviderLoginNotRunningError({ instanceId }));
  };

  const write: ProviderLoginManagerShape["write"] = (request) =>
    requireRunning(request.instanceId).pipe(
      Effect.flatMap((session) =>
        session.pty === undefined
          ? Effect.void
          : Effect.try({
              try: () => session.pty?.write(request.data),
              catch: (cause) =>
                new ProviderLoginWriteError({ instanceId: request.instanceId, cause }),
            }),
      ),
    );

  const resize: ProviderLoginManagerShape["resize"] = (request) =>
    requireRunning(request.instanceId).pipe(
      Effect.flatMap((session) =>
        session.pty === undefined
          ? Effect.void
          : Effect.try({
              try: () => session.pty?.resize(request.cols, request.rows),
              catch: (cause) =>
                new ProviderLoginWriteError({ instanceId: request.instanceId, cause }),
            }),
      ),
    );

  const cancel: ProviderLoginManagerShape["cancel"] = (request) =>
    Effect.suspend(() => {
      const session = sessions.get(request.instanceId);
      if (session && !session.exited) {
        session.exited = true;
        sessions.delete(request.instanceId);
        publish(session, { type: "exited", exitCode: 1, exitSignal: null });
        return session.cancel.pipe(Effect.ignore);
      }
      return Effect.void;
    });

  yield* Effect.addFinalizer(() =>
    Effect.forEach(sessions.values(), (session) => session.cancel.pipe(Effect.ignore), {
      discard: true,
    }).pipe(Effect.ensuring(Effect.sync(() => sessions.clear()))),
  );

  return ProviderLoginManager.of({ attachStream, write, resize, cancel });
});

export const layer = Layer.effect(ProviderLoginManager, make());
