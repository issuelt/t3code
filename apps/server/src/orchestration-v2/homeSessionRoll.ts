import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";

// Anthropic and OpenAI drop an idle prompt cache after about five minutes. Past that, resuming
// re-reads the whole native context uncached, so a fresh session with recent history is cheaper.
const PROMPT_CACHE_WINDOW = Duration.minutes(5);
const MAX_CONTEXT_SHARE = 0.5;

/**
 * Why Home's next turn should start a fresh native session seeded with its recent history instead
 * of resuming, or null to resume. Home rolls over this way so it never needs compaction.
 */
export function homeSessionRollReason(input: {
  /** When the provider thread last ran a turn; null when it never has. */
  readonly lastTurnAt: DateTime.Utc | null;
  readonly usedTokens: number | undefined;
  readonly contextWindow: number | undefined;
  readonly now: DateTime.Utc;
}): "cache_expired" | "context_half_full" | null {
  if (input.lastTurnAt === null) return null;
  if (
    input.usedTokens !== undefined &&
    input.contextWindow !== undefined &&
    input.contextWindow > 0 &&
    input.usedTokens >= input.contextWindow * MAX_CONTEXT_SHARE
  ) {
    return "context_half_full";
  }
  const idle = DateTime.distance(input.lastTurnAt, input.now);
  return Duration.isGreaterThan(idle, PROMPT_CACHE_WINDOW) ? "cache_expired" : null;
}
