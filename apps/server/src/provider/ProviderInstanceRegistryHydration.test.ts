import {
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
  ServerSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveProviderInstanceConfigMap,
  withMirroredPrimaryCustomModels,
} from "./ProviderInstanceRegistryHydration.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

const readCustomModels = (config: unknown): ReadonlyArray<string> =>
  (config as { customModels?: ReadonlyArray<string> } | undefined)?.customModels ?? [];

const at = (map: ProviderInstanceConfigMap, id: string) => map[ProviderInstanceId.make(id)];

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

  it("mirrors from the legacy providers blob when the primary slot is synthesized", () => {
    const settings = decodeSettings({
      providers: { codex: { customModels: ["legacy-custom"] } },
      providerInstances: {
        "codex-2": { driver: "codex", config: {} },
      },
    });
    const derived = deriveProviderInstanceConfigMap(settings);
    expect(readCustomModels(at(derived, "codex")?.config)).toEqual(["legacy-custom"]);
    expect(readCustomModels(at(derived, "codex-2")?.config)).toEqual(["legacy-custom"]);
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
