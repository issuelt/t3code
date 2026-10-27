/**
 * Picks the next same-driver instance, in settings order, that is enabled,
 * authenticated, opted into fallback, not cooling down, not yet tried this
 * turn, and resolves the IDENTICAL model the failed turn was running.
 */

export interface FallbackCandidateInstance {
  readonly instanceId: string;
  readonly driver: string;
  /** `ProviderInstanceConfig.participateInFallback` (absent ⇒ opted in). */
  readonly participateInFallback?: boolean | undefined;
}

export interface FallbackCandidateSnapshot {
  readonly instanceId: string;
  readonly enabled: boolean;
  /** `availability !== "unavailable"` per contracts' isProviderAvailable. */
  readonly available: boolean;
  readonly authStatus: "authenticated" | "unauthenticated" | "unknown";
  /** Model slugs the instance resolves (mirrored customs already applied at hydration). */
  readonly modelSlugs: ReadonlyArray<string>;
}

export interface SelectFallbackCandidateInput {
  /** Instances in settings order (`providerInstances` map insertion order). */
  readonly instances: ReadonlyArray<FallbackCandidateInstance>;
  /** Live snapshots keyed by instance id. */
  readonly snapshots: ReadonlyMap<string, FallbackCandidateSnapshot>;
  readonly failedInstanceId: string;
  readonly driver: string;
  readonly requiredModel: string;
  /** Instances already dispatched to during this turn (each at most once). */
  readonly attemptedInstanceIds: ReadonlySet<string>;
  /** Predicate over the in-memory limit-cooldown map. */
  readonly isCoolingDown: (instanceId: string) => boolean;
}

export type FallbackCandidateRejection =
  | "different-driver"
  | "is-failed-instance"
  | "already-attempted"
  | "not-configured-enabled"
  | "not-authenticated"
  | "opted-out"
  | "cooling-down"
  | "model-unresolvable";

/**
 * Pick the first eligible fallback instance in settings order, or null.
 * `rejections` explains why each same-driver sibling was skipped (used for
 * the no-candidate work-log hint).
 */
export function selectFallbackCandidate(input: SelectFallbackCandidateInput): {
  readonly candidate: FallbackCandidateInstance | null;
  readonly rejections: ReadonlyArray<{
    readonly instanceId: string;
    readonly reason: FallbackCandidateRejection;
  }>;
} {
  const rejections: Array<{ instanceId: string; reason: FallbackCandidateRejection }> = [];

  for (const instance of input.instances) {
    if (instance.driver !== input.driver) {
      continue; // different driver — not a sibling, not worth reporting
    }
    const reject = (reason: FallbackCandidateRejection) => {
      rejections.push({ instanceId: instance.instanceId, reason });
    };
    if (instance.instanceId === input.failedInstanceId) {
      reject("is-failed-instance");
      continue;
    }
    if (input.attemptedInstanceIds.has(instance.instanceId)) {
      reject("already-attempted");
      continue;
    }
    if (instance.participateInFallback === false) {
      reject("opted-out");
      continue;
    }
    const snapshot = input.snapshots.get(instance.instanceId);
    if (!snapshot || !snapshot.enabled || !snapshot.available) {
      reject("not-configured-enabled");
      continue;
    }
    if (snapshot.authStatus !== "authenticated") {
      reject("not-authenticated");
      continue;
    }
    if (input.isCoolingDown(instance.instanceId)) {
      reject("cooling-down");
      continue;
    }
    // Model-fidelity gate: never fall back to an instance that cannot run the
    // exact same model. No substitution, ever.
    if (!snapshot.modelSlugs.includes(input.requiredModel)) {
      reject("model-unresolvable");
      continue;
    }
    return { candidate: instance, rejections };
  }

  return { candidate: null, rejections };
}

/** Human-readable summary of why no fallback candidate existed. */
export function describeFallbackRejections(
  rejections: ReadonlyArray<{
    readonly instanceId: string;
    readonly reason: FallbackCandidateRejection;
  }>,
): string {
  const describable = rejections.filter((entry) => entry.reason !== "is-failed-instance");
  if (describable.length === 0) {
    return "no other instances of this provider are configured";
  }
  const reasonText: Record<FallbackCandidateRejection, string> = {
    "different-driver": "uses a different driver",
    "is-failed-instance": "hit the limit",
    "already-attempted": "was already tried this turn",
    "not-configured-enabled": "is disabled or unavailable",
    "not-authenticated": "is not authenticated",
    "opted-out": "is opted out of fallback",
    "cooling-down": "was recently limited",
    "model-unresolvable": "does not resolve the current model",
  };
  return describable.map((entry) => `${entry.instanceId} ${reasonText[entry.reason]}`).join("; ");
}
