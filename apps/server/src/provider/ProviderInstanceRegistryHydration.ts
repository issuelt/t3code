import {
  defaultInstanceIdForDriver,
  providerInstanceConfigEnabledFlag,
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderInstanceId,
  ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Settings from "../serverSettings.ts";
import { BUILT_IN_DRIVERS, type BuiltInDriversEnv } from "./builtInDrivers.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "./ProviderOrchestrationAdapterInfrastructure.ts";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderHostLive from "./ProviderHostLive.ts";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import type * as ServerConfig from "../config.ts";

type ProviderInstanceRegistryHydrationEnv =
  | Exclude<
      BuiltInDriversEnv,
      | ProviderOrchestrationAdapterInfrastructure.ProviderOrchestrationAdapterInfrastructure
      | AcpRegistrySupport.AcpRegistryCatalog
      | ProviderHost.ProviderHost
    >
  | Settings.ServerSettingsService
  | BackgroundPolicy.BackgroundPolicy
  | ServerConfig.ServerConfig;

export const deriveProviderInstanceConfigMap = (
  settings: ServerSettings,
): ProviderInstanceConfigMap => {
  const merged: Record<string, ProviderInstanceConfig> = { ...settings.providerInstances };

  for (const driver of BUILT_IN_DRIVERS) {
    if (driver.metadata.hasDefaultInstance === false) continue;
    const instanceId = defaultInstanceIdForDriver(driver.driverKind);
    if (instanceId in merged) continue;
    merged[instanceId] = { driver: driver.driverKind };
  }

  // A project that turns an instance on needs it alive and probed even when the machine itself
  // has it off, or a thread in that project would route to an instance nobody ever checked in
  // on.
  for (const overrides of Object.values(settings.projectSettingsOverrides)) {
    for (const [rawInstanceId, projectOverride] of Object.entries(
      overrides?.providerInstances ?? {},
    )) {
      if (projectOverride.enabled !== true) continue;
      const instanceId = rawInstanceId as ProviderInstanceId;
      const existing = merged[instanceId];
      if (existing === undefined || resolveProviderInstanceEnabled(existing)) continue;
      merged[instanceId] = {
        ...existing,
        enabled: true,
        ...(providerInstanceConfigEnabledFlag(existing.config) === false
          ? { config: { ...(existing.config as Record<string, unknown>), enabled: true } }
          : {}),
      };
    }
  }

  return withMirroredPrimaryCustomModels(merged as ProviderInstanceConfigMap);
};

/**
 * Read the `customModels` array off an opaque instance `config` payload.
 *
 * The envelope's `config` is `Schema.Unknown` (each driver decodes its own
 * shape), so we probe defensively: a well-formed value is a `string[]`, and
 * anything else — missing key, `undefined`, wrong type — reads as empty.
 */
const readConfigCustomModels = (config: unknown): ReadonlyArray<string> => {
  const models = (config as { customModels?: unknown } | undefined)?.customModels;
  return Array.isArray(models) ? (models as ReadonlyArray<string>) : [];
};

/**
 * Mirror each primary instance's `customModels` onto its non-primary
 * same-driver siblings.
 *
 * "Primary" is the instance whose id equals `defaultInstanceIdForDriver(driver)`
 * — literally the driver kind as a slug — matching how the rest of the server
 * routes the legacy single-instance-per-driver slot. Additional accounts of the
 * same driver (`codex-2`, `claude-3`, …) are non-primary siblings.
 *
 * For every non-primary sibling that hasn't opted out
 * (`mirrorPrimaryCustomModels === false`), we union the primary's custom
 * models onto the sibling's own list — the sibling's own entries keep their
 * order, and the primary's models are appended in order, skipping duplicates.
 * The primary's own config is never touched, and mirroring never crosses
 * driver kinds (each sibling only inherits from its own driver's primary).
 *
 * Purity contract: the same map reference is returned when nothing needs
 * mirroring (no siblings, no primary customs, opted out, or every primary
 * model already present), so downstream reference-equality checks stay stable.
 */
export const withMirroredPrimaryCustomModels = (
  map: ProviderInstanceConfigMap,
): ProviderInstanceConfigMap => {
  let next: Record<string, ProviderInstanceConfig> | undefined;

  for (const [id, instance] of Object.entries(map)) {
    const primaryId = defaultInstanceIdForDriver(instance.driver);
    // The primary slot itself never inherits — it is the source of truth.
    if (id === primaryId) {
      continue;
    }
    // Explicit opt-out; absent ⇒ mirror (the non-primary default).
    if (instance.mirrorPrimaryCustomModels === false) {
      continue;
    }

    const primary = map[primaryId];
    if (primary === undefined) {
      continue;
    }
    const primaryCustoms = readConfigCustomModels(primary.config);
    if (primaryCustoms.length === 0) {
      continue;
    }

    const ownCustoms = readConfigCustomModels(instance.config);
    const merged = ownCustoms.slice();
    let added = false;
    for (const model of primaryCustoms) {
      if (!merged.includes(model)) {
        merged.push(model);
        added = true;
      }
    }
    if (!added) {
      // Every primary model already present ⇒ no observable change.
      continue;
    }

    const config = {
      ...(instance.config as Record<string, unknown> | undefined),
      customModels: merged,
    };
    next ??= { ...map };
    next[id] = { ...instance, config };
  }

  return (next ?? map) as ProviderInstanceConfigMap;
};

const layerSettingsWatcher = (settingsChanges: Stream.Stream<ServerSettings>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const mutator = yield* ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator;
      const serverSettings = yield* Settings.ServerSettingsService;
      yield* settingsChanges.pipe(
        Stream.runForEach(() =>
          // The subscription predates the seed read, so a queued change can be
          // older than the seed. A failed current read must leave the registry intact.
          serverSettings.getSettings.pipe(
            Effect.flatMap((current) =>
              mutator.reconcile(deriveProviderInstanceConfigMap(current)),
            ),
            Effect.catchCause((cause) =>
              Effect.logError("ProviderInstanceRegistry reconcile failed", cause),
            ),
          ),
        ),
        Effect.forkScoped,
      );
    }),
  );

export const layer: Layer.Layer<
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  never,
  ProviderInstanceRegistryHydrationEnv
> = Layer.unwrap(
  Effect.gen(function* () {
    const serverSettings = yield* Settings.ServerSettingsService;
    // Subscribe before the seed read so saves during registry construction are queued.
    const settingsChanges = yield* serverSettings.subscribeChanges;
    const initialSettings: ServerSettings | undefined = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const initialConfigMap =
      initialSettings === undefined
        ? ({} as ProviderInstanceConfigMap)
        : deriveProviderInstanceConfigMap(initialSettings);

    const layerMutable = ProviderInstanceRegistry.layer({
      drivers: BUILT_IN_DRIVERS,
      configMap: initialConfigMap,
    }).pipe(
      Layer.provide(ProviderOrchestrationAdapterInfrastructure.layer),
      Layer.provide(AcpRegistrySupport.layerFromHost),
      Layer.provide(ProviderHostLive.layer),
    );

    return layerSettingsWatcher(settingsChanges).pipe(Layer.provideMerge(layerMutable));
  }),
) as Layer.Layer<
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  never,
  ProviderInstanceRegistryHydrationEnv
>;
