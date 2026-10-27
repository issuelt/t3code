// @effect-diagnostics globalDate:off - This pure boundary helper stores cooldown deadlines as ISO timestamps.
/**
 * Pure cooldown bookkeeping: an instance that hit a usage/rate limit is
 * skipped within the failing turn (each instance at most once per turn) and
 * briefly across turns. In-memory only.
 */

import type { ProviderLimitKind } from "./limitClassifier.ts";

/** Constant cooldown window after a limit hit (~15 minutes). */
export const LIMIT_COOLDOWN_MS = 15 * 60_000;

export interface LimitCooldownEntry {
  readonly limitedAt: number;
  /** Epoch millis when the provider says the limit resets, when known. */
  readonly resetAt?: number;
  readonly kind: ProviderLimitKind;
}

export interface LimitCooldownDisplayState {
  readonly recentlyLimited: true;
  /** ISO reset instant when the provider surfaced one; else absent. */
  readonly limitedUntil?: string;
}

export type LimitCooldownMap = ReadonlyMap<string, LimitCooldownEntry>;

/** When the cooldown for an entry ends (the later of the constant window and any reset time). */
function cooldownExpiry(entry: LimitCooldownEntry): number {
  const windowEnd = entry.limitedAt + LIMIT_COOLDOWN_MS;
  return entry.resetAt !== undefined ? Math.max(windowEnd, entry.resetAt) : windowEnd;
}

export function recordLimitHit(
  map: LimitCooldownMap,
  instanceId: string,
  input: { readonly now: number; readonly kind: ProviderLimitKind; readonly resetAt?: number },
): Map<string, LimitCooldownEntry> {
  const next = new Map(map);
  next.set(instanceId, {
    limitedAt: input.now,
    kind: input.kind,
    ...(input.resetAt !== undefined ? { resetAt: input.resetAt } : {}),
  });
  return next;
}

export function isInstanceCoolingDown(
  map: LimitCooldownMap,
  instanceId: string,
  now: number,
): boolean {
  const entry = map.get(instanceId);
  return entry !== undefined && now < cooldownExpiry(entry);
}

export function cooldownStateForInstance(
  map: LimitCooldownMap,
  instanceId: string,
  now: number,
): LimitCooldownDisplayState | null {
  const entry = map.get(instanceId);
  if (entry === undefined || now >= cooldownExpiry(entry)) {
    return null;
  }
  return entry.resetAt !== undefined
    ? { recentlyLimited: true, limitedUntil: new Date(entry.resetAt).toISOString() }
    : { recentlyLimited: true };
}

/** Drop entries whose cooldown has fully elapsed. Returns the same map when nothing changed. */
export function pruneExpired(map: LimitCooldownMap, now: number): LimitCooldownMap {
  let hasExpired = false;
  for (const entry of map.values()) {
    if (now >= cooldownExpiry(entry)) {
      hasExpired = true;
      break;
    }
  }
  if (!hasExpired) {
    return map;
  }
  const next = new Map(map);
  for (const [instanceId, entry] of next) {
    if (now >= cooldownExpiry(entry)) {
      next.delete(instanceId);
    }
  }
  return next;
}
