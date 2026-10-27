/**
 * Fallback may only proceed when the target resolves the EXACT same model id,
 * never a substitute. Same-driver instances share the built-in catalog, so
 * only custom models vary; `mirrorPrimaryCustomModels` inherits the primary's.
 */

/**
 * Resolve the effective `mirrorPrimaryCustomModels` flag. Absent defaults to
 * true for non-primary instances (they mirror the primary pool), false for the
 * primary instance itself (it owns the pool).
 */
export function resolveMirrorPrimaryCustomModels(input: {
  readonly flag: boolean | undefined;
  readonly isPrimary: boolean;
}): boolean {
  return input.flag ?? !input.isPrimary;
}

export interface TargetModelResolutionInput {
  readonly requiredModel: string;
  /** All model slugs the target instance advertises (built-in + its own custom). */
  readonly targetModelSlugs: readonly string[];
  /** The primary same-driver instance's custom model slugs. */
  readonly primaryCustomModelSlugs: readonly string[];
  /** Effective mirror flag for the target instance. */
  readonly mirrorPrimaryCustomModels: boolean;
}

/** The full set of model slugs the target instance can resolve, after mirroring. */
export function resolveTargetModelSlugs(input: TargetModelResolutionInput): ReadonlySet<string> {
  const slugs = new Set<string>(input.targetModelSlugs);
  if (input.mirrorPrimaryCustomModels) {
    for (const slug of input.primaryCustomModelSlugs) {
      slugs.add(slug);
    }
  }
  return slugs;
}

/**
 * Whether the target instance resolves the identical required model. This is
 * the fidelity gate: fallback proceeds only when this returns true.
 */
export function instanceResolvesModel(input: TargetModelResolutionInput): boolean {
  return resolveTargetModelSlugs(input).has(input.requiredModel);
}
