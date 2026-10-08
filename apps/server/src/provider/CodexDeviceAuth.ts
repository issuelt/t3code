// @effect-diagnostics globalErrorInEffectFailure:off - The app-server client exposes untagged transport failures at this boundary.
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as CodexClient from "effect-codex-app-server/client";

import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { buildCodexInitializeParams } from "./CodexProvider.ts";

export interface CodexDeviceAuthSession {
  readonly loginId: string;
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly completion: Effect.Effect<{ readonly success: boolean; readonly error?: string }>;
  readonly cancel: Effect.Effect<void, unknown>;
}

export interface CodexDeviceAuthStartInput {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export class CodexDeviceAuth extends Context.Service<
  CodexDeviceAuth,
  {
    readonly start: (
      input: CodexDeviceAuthStartInput,
    ) => Effect.Effect<CodexDeviceAuthSession, unknown, Scope.Scope>;
  }
>()("t3/provider/CodexDeviceAuth") {}

const make = Effect.fn("CodexDeviceAuth.make")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const start = Effect.fn("CodexDeviceAuth.start")(function* (input: CodexDeviceAuthStartInput) {
    const command = yield* resolveSpawnCommand(input.binaryPath, ["app-server"], {
      env: input.env,
      extendEnv: true,
    });
    const child = yield* spawner.spawn(
      ChildProcess.make(command.command, command.args, {
        cwd: input.cwd,
        env: input.env,
        extendEnv: true,
        forceKillAfter: "2 seconds",
        shell: command.shell,
      }),
    );
    const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );
    yield* client.request("initialize", buildCodexInitializeParams());
    yield* client.notify("initialized", undefined);

    const completed = yield* Deferred.make<{
      readonly success: boolean;
      readonly error?: string;
    }>();
    let activeLoginId: string | undefined;
    yield* client.handleServerNotification("account/login/completed", (event) => {
      if (activeLoginId !== undefined && event.loginId !== activeLoginId) return Effect.void;
      return Deferred.succeed(
        completed,
        event.error ? { success: event.success, error: event.error } : { success: event.success },
      ).pipe(Effect.asVoid);
    });

    const response = yield* client.request("account/login/start", {
      type: "chatgptDeviceCode",
    });
    if (response.type !== "chatgptDeviceCode") {
      return yield* Effect.fail(new Error(`Unexpected Codex login response: ${response.type}`));
    }
    activeLoginId = response.loginId;

    return {
      loginId: response.loginId,
      verificationUrl: response.verificationUrl,
      userCode: response.userCode,
      completion: Deferred.await(completed),
      cancel: client
        .request("account/login/cancel", { loginId: response.loginId })
        .pipe(Effect.andThen(child.kill()), Effect.asVoid),
    } satisfies CodexDeviceAuthSession;
  });

  return CodexDeviceAuth.of({ start });
});

export const layer = Layer.effect(CodexDeviceAuth, make());
