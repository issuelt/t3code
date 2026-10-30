import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
  ServerSettings,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  DEV_REPLAY_INSTANCE_ID,
  deriveProviderInstanceConfigMap,
  seedDevReplayInstance,
  withMirroredPrimaryCustomModels,
} from "./ProviderInstanceRegistryHydration.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

const readCustomModels = (config: unknown): ReadonlyArray<string> =>
  (config as { customModels?: ReadonlyArray<string> } | undefined)?.customModels ?? [];

const at = (map: ProviderInstanceConfigMap, id: string) => map[ProviderInstanceId.make(id)];

const projectId = ProjectId.make("project-a");
const instanceId = ProviderInstanceId.make("codex_work");

function settingsWith(overrides: Partial<ServerSettings>): ServerSettings {
  return { ...DEFAULT_SERVER_SETTINGS, ...overrides };
}

describe("withMirroredPrimaryCustomModels", () => {
  it("mirrors the primary instance's custom models onto non-primary siblings by default", () => {
    const settings = decodeSettings({
      providerInstances: {
        codex: { driver: "codex", config: { customModels: ["my-custom", "another"] } },
        "codex-2": { driver: "codex", config: { homePath: "/homes/codex-2" } },
      },
    });
    const derived = deriveProviderInstanceConfigMap(settings);
    const mirrored = readCustomModels(at(derived, "codex-2")?.config);
    expect(mirrored).toEqual(["my-custom", "another"]);
    // Primary keeps its own list untouched.
    expect(readCustomModels(at(derived, "codex")?.config)).toEqual(["my-custom", "another"]);
  });

  it("unions with the sibling's own custom models without duplicates", () => {
    const settings = decodeSettings({
      providerInstances: {
        codex: { driver: "codex", config: { customModels: ["shared", "primary-only"] } },
        "codex-2": { driver: "codex", config: { customModels: ["shared", "own-only"] } },
      },
    });
    const derived = deriveProviderInstanceConfigMap(settings);
    expect(readCustomModels(at(derived, "codex-2")?.config)).toEqual([
      "shared",
      "own-only",
      "primary-only",
    ]);
  });

  it("does not mirror when the sibling opted out", () => {
    const settings = decodeSettings({
      providerInstances: {
        codex: { driver: "codex", config: { customModels: ["my-custom"] } },
        "codex-2": {
          driver: "codex",
          mirrorPrimaryCustomModels: false,
          config: {},
        },
      },
    });
    const derived = deriveProviderInstanceConfigMap(settings);
    expect(readCustomModels(at(derived, "codex-2")?.config)).toEqual([]);
  });

  it("never mirrors across drivers", () => {
    const settings = decodeSettings({
      providerInstances: {
        codex: { driver: "codex", config: { customModels: ["codex-custom"] } },
        "claude-2": { driver: "claudeAgent", config: {} },
      },
    });
    const derived = deriveProviderInstanceConfigMap(settings);
    expect(readCustomModels(at(derived, "claude-2")?.config)).toEqual([]);
  });

  it("returns the same map reference when nothing needs mirroring", () => {
    const settings = decodeSettings({
      providerInstances: {
        codex: { driver: "codex", config: {} },
        "codex-2": { driver: "codex", config: {} },
      },
    });
    const map = settings.providerInstances;
    expect(withMirroredPrimaryCustomModels(map)).toBe(map);
  });
});

describe("deriveProviderInstanceConfigMap", () => {
  it("turns a machine-disabled instance on when a project enables it", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toEqual({ driver: ProviderDriverKind.make("codex"), enabled: true });
  });

  it("clears a nested config.enabled:false flag when a project enables the instance", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("codex"),
          config: { enabled: false },
        },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toEqual({
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: { enabled: true },
    });
  });

  it("does not revive an instance a project override references but settings no longer configure", () => {
    const settings = settingsWith({
      providerInstances: {},
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toBeUndefined();
  });

  it("ignores a project override that disables an instance, leaving the machine's config in charge", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toBe(settings.providerInstances[instanceId]);
  });
});

describe("seedDevReplayInstance", () => {
  const seed = (devUrl: URL | undefined) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      yield* seedDevReplayInstance().pipe(
        Effect.provideService(ServerConfig.ServerConfig, { ...config, devUrl }),
      );
      const settings = yield* ServerSettingsService;
      return (yield* settings.getSettings).providerInstances[DEV_REPLAY_INSTANCE_ID];
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-dev-replay-seed-" }),
          ServerSettingsService.layerTest({
            providerInstances: {
              [DEV_REPLAY_INSTANCE_ID]: {
                driver: ProviderDriverKind.make("acpRegistry"),
                displayName: "My replay",
                enabled: false,
                config: { source: "local", commandPath: "/old/node" },
              },
            },
          }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );

  effectIt.effect("leaves settings alone outside dev", () =>
    seed(undefined).pipe(
      Effect.map((instance) =>
        expect(instance?.config).toEqual({ source: "local", commandPath: "/old/node" }),
      ),
    ),
  );

  effectIt.effect("points a dev server at the replay agent and keeps user edits", () =>
    seed(new URL("http://localhost:5733")).pipe(
      Effect.map((instance) => {
        expect(instance?.displayName).toBe("My replay");
        expect(instance?.enabled).toBe(false);
        expect(instance?.config).toMatchObject({
          source: "local",
          commandArgs: [expect.stringMatching(/scripts[/\\]dev-replay-agent\.ts$/)],
        });
      }),
    ),
  );
});
