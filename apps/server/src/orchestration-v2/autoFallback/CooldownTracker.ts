// @effect-diagnostics globalDate:off - Cooldown snapshots cross a JSON boundary as ISO timestamps.
/**
 * Shared in-memory limit-cooldown state, read by candidate selection and the
 * ws snapshot path (`recentlyLimited` / `limitedUntil`). Never persisted: a
 * restart clears all cooldowns, which suits volatile provider-side limits.
 */
import type { ServerProvider } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  type LimitCooldownDisplayState,
  type LimitCooldownEntry,
  cooldownStateForInstance,
  isInstanceCoolingDown,
  pruneExpired,
  recordLimitHit,
} from "./cooldown.ts";
import type { ProviderLimitKind } from "./limitClassifier.ts";

export interface AutoFallbackCooldownTrackerShape {
  /** Flag an instance as limit-hit at "now". */
  readonly recordLimitHit: (
    instanceId: string,
    input: { readonly kind: ProviderLimitKind; readonly resetAt?: string | undefined },
  ) => Effect.Effect<void>;
  /** Whether the instance is inside its cooldown window. */
  readonly isCoolingDown: (instanceId: string) => Effect.Effect<boolean>;
  /** Snapshot of every instance currently cooling down (pruned). */
  readonly snapshot: Effect.Effect<ReadonlyMap<string, LimitCooldownEntry>>;
  /** Badge state for one instance, or null when not limited. */
  readonly displayState: (instanceId: string) => Effect.Effect<LimitCooldownDisplayState | null>;
  /** Decorate provider snapshots with `recentlyLimited` / `limitedUntil`. */
  readonly decorateProviders: (
    providers: ReadonlyArray<ServerProvider>,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;
}

export class AutoFallbackCooldownTracker extends Context.Service<
  AutoFallbackCooldownTracker,
  AutoFallbackCooldownTrackerShape
>()("t3/orchestration-v2/autoFallback/CooldownTracker/AutoFallbackCooldownTracker") {}

const make = Effect.gen(function* () {
  const stateRef = yield* Ref.make<ReadonlyMap<string, LimitCooldownEntry>>(new Map());

  const parseResetAt = (resetAt: string | undefined): number | undefined => {
    if (resetAt === undefined) {
      return undefined;
    }
    const parsed = Date.parse(resetAt);
    return Number.isNaN(parsed) ? undefined : parsed;
  };

  const service: AutoFallbackCooldownTrackerShape = {
    recordLimitHit: (instanceId, input) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => {
          const resetAt = parseResetAt(input.resetAt);
          return Ref.update(stateRef, (state) =>
            recordLimitHit(state, instanceId, {
              now,
              kind: input.kind,
              ...(resetAt !== undefined ? { resetAt } : {}),
            }),
          );
        }),
      ),
    isCoolingDown: (instanceId) =>
      Effect.all([Ref.get(stateRef), Clock.currentTimeMillis]).pipe(
        Effect.map(([state, now]) => isInstanceCoolingDown(state, instanceId, now)),
      ),
    snapshot: Effect.all([Ref.get(stateRef), Clock.currentTimeMillis]).pipe(
      Effect.flatMap(([state, now]) => {
        const pruned = pruneExpired(state, now);
        return pruned === state
          ? Effect.succeed(state)
          : Ref.set(stateRef, pruned).pipe(Effect.as(pruned));
      }),
    ),
    displayState: (instanceId) =>
      Effect.all([Ref.get(stateRef), Clock.currentTimeMillis]).pipe(
        Effect.map(([state, now]) => cooldownStateForInstance(state, instanceId, now)),
      ),
    decorateProviders: (providers) =>
      Effect.all([Ref.get(stateRef), Clock.currentTimeMillis]).pipe(
        Effect.map(([state, now]) =>
          providers.map((provider) => {
            const display = cooldownStateForInstance(state, String(provider.instanceId), now);
            if (display === null) {
              return provider;
            }
            return {
              ...provider,
              recentlyLimited: true as const,
              ...(display.limitedUntil !== undefined ? { limitedUntil: display.limitedUntil } : {}),
            };
          }),
        ),
      ),
  };

  return service;
});

export const AutoFallbackCooldownTrackerLive = Layer.effect(AutoFallbackCooldownTracker, make);
