// @effect-diagnostics globalDate:off - Fixtures intentionally exercise provider timestamp normalization.
import { describe, expect, it } from "vite-plus/test";

import {
  classifyProviderLimitError,
  devForcedLimitClassification,
  extractResetAt,
} from "./limitClassifier.ts";

describe("classifyProviderLimitError", () => {
  describe("codex", () => {
    it("classifies the V2 error notification usageLimitExceeded marker", () => {
      // Shape per effect-codex-app-server V2ErrorNotification.
      const detail = {
        error: {
          message: "You've hit your usage limit. Try again later.",
          codexErrorInfo: "usageLimitExceeded",
          additionalDetails: null,
        },
        threadId: "thread-1",
        turnId: "1",
        willRetry: false,
      };
      expect(
        classifyProviderLimitError({
          driver: "codex",
          message: "You've hit your usage limit. Try again later.",
          detail,
        }),
      ).toEqual({ kind: "usage_limit" });
    });

    it("classifies usageLimitExceeded carried on the raw turn/completed payload", () => {
      const detail = {
        turn: {
          status: "failed",
          error: {
            message: "usage limit reached",
            codexErrorInfo: "usageLimitExceeded",
          },
        },
      };
      expect(classifyProviderLimitError({ driver: "codex", detail })).toEqual({
        kind: "usage_limit",
      });
    });

    it("classifies struct-shaped codexErrorInfo with a 429 status as rate limit", () => {
      const detail = {
        error: {
          message: "Too many failed attempts.",
          codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
        },
        willRetry: false,
      };
      expect(classifyProviderLimitError({ driver: "codex", detail })).toEqual({
        kind: "rate_limit",
      });
    });

    it("falls back to message classification when no structured detail exists", () => {
      expect(
        classifyProviderLimitError({
          driver: "codex",
          message: "Rate limit reached. Please try again later.",
        }),
      ).toEqual({ kind: "rate_limit" });
    });

    it("does not classify context-window or generic provider errors", () => {
      expect(
        classifyProviderLimitError({
          driver: "codex",
          message: "Your input exceeds the context window of this model.",
          detail: {
            error: {
              message: "Your input exceeds the context window of this model.",
              codexErrorInfo: "contextWindowExceeded",
            },
          },
        }),
      ).toBeNull();
      expect(
        classifyProviderLimitError({
          driver: "codex",
          message: "Internal server error",
          detail: { error: { message: "Internal server error", codexErrorInfo: "other" } },
        }),
      ).toBeNull();
    });

    it("does not classify unauthorized errors", () => {
      expect(
        classifyProviderLimitError({
          driver: "codex",
          message: "Not logged in",
          detail: { error: { message: "Not logged in", codexErrorInfo: "unauthorized" } },
        }),
      ).toBeNull();
    });
  });

  describe("claudeAgent", () => {
    it("classifies the classic pipe-epoch limit message and extracts the reset time", () => {
      const result = classifyProviderLimitError({
        driver: "claudeAgent",
        message: "Claude AI usage limit reached|1783200000",
      });
      expect(result?.kind).toBe("usage_limit");
      expect(result?.resetAt).toBe(new Date(1_783_200_000 * 1000).toISOString());
    });

    it("classifies the prose usage-limit message", () => {
      expect(
        classifyProviderLimitError({
          driver: "claudeAgent",
          message: "Claude usage limit reached. Your limit will reset at 6pm (Europe/Zagreb).",
        }),
      ).toEqual({ kind: "usage_limit" });
    });

    it("classifies API 429 rate-limit errors", () => {
      expect(
        classifyProviderLimitError({
          driver: "claudeAgent",
          message:
            'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
        }),
      ).toEqual({ kind: "rate_limit" });
    });

    it("does not classify unrelated failures", () => {
      expect(
        classifyProviderLimitError({
          driver: "claudeAgent",
          message: "Claude turn failed.",
        }),
      ).toBeNull();
      expect(
        classifyProviderLimitError({
          driver: "claudeAgent",
          message: "Invalid API key. Please run /login.",
        }),
      ).toBeNull();
    });
  });

  it("never classifies drivers outside the fallback set", () => {
    expect(
      classifyProviderLimitError({
        driver: "cursor",
        message: "usage limit reached",
      }),
    ).toBeNull();
    expect(
      classifyProviderLimitError({
        driver: "grok",
        message: "rate limit exceeded",
      }),
    ).toBeNull();
  });
});

describe("extractResetAt", () => {
  it("reads unix-second reset stamps", () => {
    const now = 1_783_200_000_000;
    const seconds = 1_783_203_600;
    expect(extractResetAt({ resetsAt: seconds }, now)).toBe(new Date(seconds * 1000).toISOString());
  });

  it("reads nested rate-limit window stamps", () => {
    const now = 1_783_200_000_000;
    const seconds = 1_783_200_600;
    expect(extractResetAt({ rateLimits: { primary: { resetsAt: seconds } } }, now)).toBe(
      new Date(seconds * 1000).toISOString(),
    );
  });

  it("returns undefined for details without reset info", () => {
    expect(extractResetAt({ error: { message: "boom" } })).toBeUndefined();
    expect(extractResetAt(undefined)).toBeUndefined();
    expect(extractResetAt("string")).toBeUndefined();
  });
});

describe("devForcedLimitClassification", () => {
  it("is off for unset or falsy values", () => {
    expect(devForcedLimitClassification(undefined)).toBeNull();
    expect(devForcedLimitClassification("")).toBeNull();
    expect(devForcedLimitClassification("0")).toBeNull();
    expect(devForcedLimitClassification("false")).toBeNull();
    expect(devForcedLimitClassification("off")).toBeNull();
  });

  it("forces a usage-limit classification for truthy values", () => {
    expect(devForcedLimitClassification("1")).toEqual({ kind: "usage_limit" });
    expect(devForcedLimitClassification("true")).toEqual({ kind: "usage_limit" });
  });
});
