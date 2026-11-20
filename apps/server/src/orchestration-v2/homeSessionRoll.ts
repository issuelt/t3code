import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";

// Matches Claude's 1h subscription prompt cache TTL and gives providers without
// context-usage telemetry (Cursor, OpenCode) a regular rollover boundary.
const IDLE_ROLL_WINDOW = Duration.hours(1);
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
  readonly autoCompactThreshold: number | undefined;
  readonly now: DateTime.Utc;
}): "context_full" | "idle" | null {
  if (input.lastTurnAt === null) return null;
  if (input.usedTokens !== undefined) {
    const usedTokens = input.usedTokens;
    const limits = [
      input.contextWindow !== undefined && input.contextWindow > 0
        ? input.contextWindow * MAX_CONTEXT_SHARE
        : undefined,
      input.autoCompactThreshold,
    ];
    if (limits.some((limit) => limit !== undefined && usedTokens >= limit)) {
      return "context_full";
    }
  }
  return DateTime.isGreaterThanOrEqualTo(
    input.now,
    DateTime.addDuration(input.lastTurnAt, IDLE_ROLL_WINDOW),
  )
    ? "idle"
    : null;
}
