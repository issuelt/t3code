const MAX_CONTEXT_SHARE = 0.5;

/**
 * Whether Home's next turn should start a fresh native session seeded with its recent history
 * instead of resuming. Home rolls over at half its context so it never needs compaction.
 */
export function homeContextHalfFull(input: {
  /** The native context the provider measured on its last request. */
  readonly usedTokens: number | undefined;
  readonly contextWindow: number | undefined;
}): boolean {
  return (
    input.usedTokens !== undefined &&
    input.contextWindow !== undefined &&
    input.contextWindow > 0 &&
    input.usedTokens >= input.contextWindow * MAX_CONTEXT_SHARE
  );
}
