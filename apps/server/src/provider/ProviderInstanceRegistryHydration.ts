/**
 * ProviderInstanceRegistryHydration — derive a `ProviderInstanceConfigMap`
 * from `ServerSettings` and keep `ProviderInstanceRegistry` in sync with it.
 *
 * `settings.providerInstances` is the source of truth. Every built-in driver
 * with a default instance also runs at `defaultInstanceIdForDriver(kind)`
 * when that slot has no entry, using the driver's default config, so a fresh
 * install shows its built-in providers without writing settings first.
 *
 * Hot-reload
 * ----------
 * On layer build we:
 *   1. Read the current `ServerSettings` once and use it to seed the
 *      registry's initial state via `ProviderInstanceRegistry.layer`.
 *   2. Fork a daemon fiber (lifetime tied to the layer's scope) that
 *      acquires `ServerSettingsService.subscribeChanges` and calls
 *      `ProviderInstanceRegistryMutator.reconcile` on every emission.
 *
 * Failures inside the watcher are logged and swallowed so a single bad
 * settings emission cannot kill the registry. Unknown drivers and invalid
 * configs already round-trip through the registry's own "unavailable"
 * shadow bucket.
 *
 * @module provider/ProviderInstanceRegistryHydration
 */
import {
  defaultInstanceIdForDriver,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
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
  // Requirements of the `ProviderHost.ProviderHost` the drivers receive.
  | BackgroundPolicy.BackgroundPolicy
  | ServerConfig.ServerConfig;

/**
 * Explicit `providerInstances` entries plus an implicit default instance for
 * each built-in driver whose default slot is empty. Pure so the hydration
 * rule can be tested without layers.
 */
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

/**
 * Layer that consumes `ProviderInstanceRegistryMutator` and forks a
 * settings-watcher fiber. The fiber's lifetime is tied to the enclosing
 * layer scope (process lifetime in production), so it is interrupted on
 * shutdown without leaking.
 *
 * Errors inside the watcher are logged and swallowed — the registry's own
 * "unavailable" bucket already absorbs unknown drivers and invalid
 * configs, so the only way the watcher could fail is a settings stream
 * tear-down, which logs and exits cleanly.
 */
const layerSettingsWatcher = Layer.effectDiscard(
  Effect.gen(function* () {
    const mutator = yield* ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator;
    const serverSettings = yield* Settings.ServerSettingsService;
    const settingsChanges = yield* serverSettings.subscribeChanges;
    yield* settingsChanges.pipe(
      Stream.runForEach((next) =>
        mutator
          .reconcile(deriveProviderInstanceConfigMap(next))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("ProviderInstanceRegistry reconcile failed", cause),
            ),
          ),
      ),
      Effect.forkScoped,
    );
  }),
);

/**
 * Hydrate `ProviderInstanceRegistry` from `ServerSettings` and keep it in
 * sync with subsequent `streamChanges` emissions.
 *
 * The Layer's two halves:
 *   - `ProviderInstanceRegistry.layer` produces the registry +
 *     mutator from the initial config map. Its scope owns every
 *     per-instance child scope created during reconcile.
 *   - `SettingsWatcherLive` consumes the mutator, acquires its settings
 *     subscription before forking, and runs a daemon fiber in the same scope.
 *
 * Composing via `Layer.provideMerge` makes the watcher's deps available
 * from the mutable layer while still surfacing the registry as an output.
 * The mutator tag is technically also exposed; only this module imports
 * it, so the visibility leak is harmless in practice.
 */
export const layer: Layer.Layer<
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  never,
  ProviderInstanceRegistryHydrationEnv
> = Layer.unwrap(
  Effect.gen(function* () {
    const serverSettings = yield* Settings.ServerSettingsService;
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

    return layerSettingsWatcher.pipe(Layer.provideMerge(layerMutable));
  }),
) as Layer.Layer<
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  never,
  ProviderInstanceRegistryHydrationEnv
>;
