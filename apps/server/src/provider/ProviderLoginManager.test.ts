import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderLoginStreamEvent,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import {
  PtyAdapter,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnInput,
} from "../terminal/PtyAdapter.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderRegistry } from "./ProviderRegistry.ts";
import { CodexDeviceAuth, type CodexDeviceAuthStartInput } from "./CodexDeviceAuth.ts";
import * as ProviderLoginManager from "./ProviderLoginManager.ts";

interface FakePty extends PtyProcess {
  readonly spawnInput: PtySpawnInput;
  readonly writes: string[];
  killed: boolean;
  emitData(data: string): void;
  emitExit(exitCode: number, signal: number | null): void;
}

// Shared recorders — reset at the start of each test.
const spawned: FakePty[] = [];
const refreshed: string[] = [];
const codexStarts: CodexDeviceAuthStartInput[] = [];
let codexCanceled = false;
let codexCompletion: Effect.Effect<{ readonly success: boolean }> = Effect.never;
let settingsOverride: ServerSettings = DEFAULT_SERVER_SETTINGS;

const reset = (settings: ServerSettings) => {
  spawned.length = 0;
  refreshed.length = 0;
  codexStarts.length = 0;
  codexCanceled = false;
  codexCompletion = Effect.never;
  settingsOverride = settings;
};

const settingsWithInstances = (instances: ServerSettings["providerInstances"]): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: instances,
});

const FakePtyAdapterLayer = Layer.succeed(
  PtyAdapter,
  PtyAdapter.of({
    spawn: (input: PtySpawnInput) =>
      Effect.sync(() => {
        const dataCbs = new Set<(data: string) => void>();
        const exitCbs = new Set<(event: PtyExitEvent) => void>();
        const fake: FakePty = {
          pid: 4242,
          spawnInput: input,
          writes: [],
          killed: false,
          write(data) {
            this.writes.push(data);
          },
          resize() {},
          kill() {
            this.killed = true;
          },
          onData(cb) {
            dataCbs.add(cb);
            return () => dataCbs.delete(cb);
          },
          onExit(cb) {
            exitCbs.add(cb);
            return () => exitCbs.delete(cb);
          },
          emitData(data) {
            for (const cb of dataCbs) cb(data);
          },
          emitExit(exitCode, signal) {
            for (const cb of exitCbs) cb({ exitCode, signal });
          },
        };
        spawned.push(fake);
        return fake;
      }),
  }),
);

const ServerSettingsMock = Layer.mock(ServerSettingsService)({
  getSettings: Effect.sync(() => settingsOverride),
  updateSettings: () => Effect.die("updateSettings not used in ProviderLoginManager tests"),
  streamChanges: Stream.empty,
  start: Effect.void,
  ready: Effect.void,
});

const ProviderRegistryMock = Layer.mock(ProviderRegistry)({
  getProviders: Effect.succeed([]),
  refresh: () => Effect.succeed([]),
  refreshInstance: (id) =>
    Effect.sync(() => {
      refreshed.push(id);
      return [];
    }),
  getProviderMaintenanceCapabilitiesForInstance: () =>
    Effect.die("not used in ProviderLoginManager tests"),
  setProviderMaintenanceActionState: () => Effect.succeed([]),
  streamChanges: Stream.empty,
});

const CodexDeviceAuthMock = Layer.succeed(
  CodexDeviceAuth,
  CodexDeviceAuth.of({
    start: (input) =>
      Effect.sync(() => {
        codexStarts.push(input);
        return {
          loginId: "login-1",
          verificationUrl: "https://auth.openai.com/device",
          userCode: "ABCD-1234",
          completion: codexCompletion,
          cancel: Effect.sync(() => {
            codexCanceled = true;
          }),
        };
      }),
  }),
);

const TestLayer = ProviderLoginManager.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      FakePtyAdapterLayer,
      CodexDeviceAuthMock,
      ServerSettingsMock,
      ProviderRegistryMock,
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const codexInstance = (id: string, config: Record<string, unknown>) => ({
  [ProviderInstanceId.make(id)]: {
    driver: ProviderDriverKind.make("codex"),
    config,
  },
});

const collectInto = (events: ProviderLoginStreamEvent[]) => (event: ProviderLoginStreamEvent) =>
  Effect.sync(() => {
    events.push(event);
  });

const waitUntil = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      yield* Effect.sleep(Duration.millis(5));
    }
    throw new Error("timed out waiting for condition");
  });

it.layer(TestLayer)("ProviderLoginManager", (it) => {
  it.effect("starts structured Codex device auth and refreshes on completion", () =>
    Effect.gen(function* () {
      reset(settingsWithInstances(codexInstance("codex_lifecycle", {})));
      codexCompletion = Effect.succeed({ success: true });
      const manager = yield* ProviderLoginManager.ProviderLoginManager;
      const events: ProviderLoginStreamEvent[] = [];

      const unsubscribe = yield* manager.attachStream(
        { instanceId: ProviderInstanceId.make("codex_lifecycle") },
        collectInto(events),
      );

      expect(spawned).toHaveLength(0);
      expect(codexStarts).toHaveLength(1);
      expect(codexStarts[0]!.binaryPath).toBe("codex");

      // The "started" event was replayed synchronously on attach.
      expect(events.find((event) => event.type === "started")).toMatchObject({
        type: "started",
        driver: "codex",
        commandLabel: "codex app-server: account/login/start",
      });
      expect(events.find((event) => event.type === "challenge")).toMatchObject({
        type: "challenge",
        url: "https://auth.openai.com/device",
        code: "ABCD-1234",
      });
      yield* waitUntil(() => events.some((event) => event.type === "exited"));
      expect(events.find((event) => event.type === "exited")).toMatchObject({
        type: "exited",
        exitCode: 0,
      });

      // Exit triggers a health re-probe for the instance.
      yield* waitUntil(() => refreshed.includes("codex_lifecycle"));
      expect(refreshed).toContain("codex_lifecycle");

      unsubscribe();
    }),
  );

  it.effect("isolates CODEX_HOME to the instance's home directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-login-home-" });
      reset(settingsWithInstances(codexInstance("codex_home", { homePath: home })));

      const manager = yield* ProviderLoginManager.ProviderLoginManager;
      const unsubscribe = yield* manager.attachStream(
        { instanceId: ProviderInstanceId.make("codex_home") },
        () => Effect.void,
      );

      expect(codexStarts).toHaveLength(1);
      expect(codexStarts[0]!.env.CODEX_HOME).toBe(path.resolve(home));
      expect(yield* fs.exists(home)).toBe(true);

      unsubscribe();
    }),
  );

  it.effect("cancel cancels structured Codex device auth", () =>
    Effect.gen(function* () {
      reset(settingsWithInstances(codexInstance("codex_cancel", {})));
      const manager = yield* ProviderLoginManager.ProviderLoginManager;
      const unsubscribe = yield* manager.attachStream(
        { instanceId: ProviderInstanceId.make("codex_cancel") },
        () => Effect.void,
      );

      expect(codexCanceled).toBe(false);
      yield* manager.cancel({ instanceId: ProviderInstanceId.make("codex_cancel") });
      expect(codexCanceled).toBe(true);

      unsubscribe();
    }),
  );

  it.effect("fails for an unknown instance", () =>
    Effect.gen(function* () {
      reset(settingsWithInstances({}));
      const manager = yield* ProviderLoginManager.ProviderLoginManager;
      const result = yield* Effect.exit(
        manager.attachStream(
          { instanceId: ProviderInstanceId.make("codex_missing") },
          () => Effect.void,
        ),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("rejects a driver that does not support in-app login", () =>
    Effect.gen(function* () {
      reset(
        settingsWithInstances({
          [ProviderInstanceId.make("grok_x")]: {
            driver: ProviderDriverKind.make("grok"),
            config: {},
          },
        }),
      );
      const manager = yield* ProviderLoginManager.ProviderLoginManager;
      const result = yield* Effect.exit(
        manager.attachStream({ instanceId: ProviderInstanceId.make("grok_x") }, () => Effect.void),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});

describe("ProviderLoginManager module", () => {
  it("exposes a layer", () => {
    expect(ProviderLoginManager.layer).toBeDefined();
  });
});
