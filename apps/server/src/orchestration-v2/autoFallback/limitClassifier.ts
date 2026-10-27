// @effect-diagnostics globalDate:off - Provider retry metadata is normalized at this pure boundary as ISO timestamps.
/**
 * Only genuine usage/rate-limit deaths may trigger auto-fallback. Codex is
 * detected by `codexErrorInfo === "usageLimitExceeded"` in the raw error
 * `detail`, with free-text fallbacks; Claude has no structured code, so it is
 * matched on the "usage limit reached" / rate-limit phrasing.
 */

export type ProviderLimitKind = "usage_limit" | "rate_limit";

export interface ProviderLimitClassification {
  readonly kind: ProviderLimitKind;
  /** ISO-8601 reset instant when the provider surfaced one; else undefined. */
  readonly resetAt?: string;
}

export interface ClassifyProviderLimitErrorInput {
  /** The provider driver kind (e.g. "codex", "claudeAgent"). */
  readonly driver: string;
  /** Terminal error text (errorMessage / reason / runtime.error message). */
  readonly message?: string | undefined;
  /** Raw provider error detail — for codex this is the V2ErrorNotification. */
  readonly detail?: unknown;
}

const USAGE_LIMIT_PATTERNS: readonly RegExp[] = [
  /usage limit reached/i,
  /usage limit exceeded/i,
  /reached your usage limit/i,
  /hit your usage limit/i,
  /you'?ve reached the usage limit/i,
  /plan limit reached/i,
  /quota exceeded/i,
];

const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /rate limit/i,
  /rate_limit/i,
  /too many requests/i,
  /\b429\b/,
];

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Best-effort extraction of a reset instant (ISO-8601) from a raw provider
 * error/rate-limit detail. Codex rate-limit windows carry `resetsAt` as unix
 * seconds; some payloads nest it under `error`/`rateLimits`.
 */
export function extractResetAt(detail: unknown, now: number = Date.now()): string | undefined {
  const root = readRecord(detail);
  if (!root) {
    return undefined;
  }
  const candidates: unknown[] = [
    root.resetsAt,
    root.reset_at,
    root.resetAt,
    readRecord(root.error)?.resetsAt,
    readRecord(root.rateLimits)?.resetsAt,
    readRecord(readRecord(root.rateLimits)?.primary)?.resetsAt,
    readRecord(readRecord(root.rateLimits)?.secondary)?.resetsAt,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      // Heuristic: seconds vs. millis. Treat < 1e12 as unix seconds.
      const millis = candidate < 1e12 ? candidate * 1000 : candidate;
      if (millis > now - 60_000) {
        return new Date(millis).toISOString();
      }
    }
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) {
        return new Date(parsed).toISOString();
      }
    }
  }
  return undefined;
}

function classifyMessage(message: string | undefined): ProviderLimitKind | undefined {
  const text = message?.trim();
  if (!text) {
    return undefined;
  }
  if (USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(text))) {
    return "usage_limit";
  }
  if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text))) {
    return "rate_limit";
  }
  return undefined;
}

function classifyCodexDetail(detail: unknown): ProviderLimitKind | undefined {
  const root = readRecord(detail);
  if (!root) {
    return undefined;
  }
  // `codexErrorInfo` lives on `error` for the V2 `error` notification and on
  // `turn.error` for the raw `turn/completed` payload.
  const errorRecord = readRecord(root.error) ?? readRecord(readRecord(root.turn)?.error);
  const errorInfo = errorRecord?.codexErrorInfo ?? root.codexErrorInfo;
  if (errorInfo === "usageLimitExceeded") {
    return "usage_limit";
  }
  // Struct-shaped codexErrorInfo variants carry an httpStatusCode; a 429
  // anywhere in them is a rate limit.
  const errorInfoRecord = readRecord(errorInfo);
  if (errorInfoRecord) {
    for (const variant of Object.values(errorInfoRecord)) {
      const statusCode = readRecord(variant)?.httpStatusCode;
      if (statusCode === 429) {
        return "rate_limit";
      }
    }
  }
  const rateLimitType = root.type ?? root.rateLimitType;
  if (typeof rateLimitType === "string") {
    if (
      rateLimitType === "rate_limit_reached" ||
      rateLimitType === "workspace_owner_usage_limit_reached" ||
      rateLimitType === "workspace_member_usage_limit_reached"
    ) {
      return rateLimitType === "rate_limit_reached" ? "rate_limit" : "usage_limit";
    }
  }
  return undefined;
}

/**
 * Claude Code's classic limit format embeds the reset epoch after a pipe:
 * "Claude AI usage limit reached|1712345678".
 */
function extractResetAtFromMessage(message: string | undefined): string | undefined {
  const match = message?.match(/limit reached\|(\d{9,13})/i);
  if (!match?.[1]) {
    return undefined;
  }
  const value = Number(match[1]);
  const millis = value < 1e12 ? value * 1000 : value;
  return new Date(millis).toISOString();
}

/**
 * Classify a terminal provider error as a usage/rate-limit event, or `null`
 * when it is not a limit error (so fallback must NOT trigger).
 */
export function classifyProviderLimitError(
  input: ClassifyProviderLimitErrorInput,
): ProviderLimitClassification | null {
  // Only the home-aware, multi-account drivers participate in fallback.
  if (input.driver !== "codex" && input.driver !== "claudeAgent") {
    return null;
  }

  let kind: ProviderLimitKind | undefined;
  if (input.driver === "codex") {
    kind = classifyCodexDetail(input.detail) ?? classifyMessage(input.message);
  } else {
    kind = classifyMessage(input.message);
  }

  if (!kind) {
    return null;
  }
  const resetAt = extractResetAt(input.detail) ?? extractResetAtFromMessage(input.message);
  return resetAt !== undefined ? { kind, resetAt } : { kind };
}

/**
 * Dev-only override: when `T3CODE_FORCE_LIMIT_FALLBACK` is truthy, the next
 * terminal error is treated as a usage limit so the whole fallback path can be
 * exercised without a real limit event. Gated to non-production by callers.
 */
export function devForcedLimitClassification(
  envValue: string | undefined,
): ProviderLimitClassification | null {
  if (!envValue) {
    return null;
  }
  const normalized = envValue.trim().toLowerCase();
  if (normalized === "" || normalized === "0" || normalized === "false" || normalized === "off") {
    return null;
  }
  return { kind: "usage_limit" };
}
