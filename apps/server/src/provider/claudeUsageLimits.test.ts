import { describe, expect, it } from "vite-plus/test";

import { claudeRateLimitEventToUpdate, claudeUsageResponseToLimits } from "./claudeUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";
const noNames = { overageIncluded: undefined } as const;

describe("claudeUsageResponseToLimits", () => {
  it("maps Claude paid-plan usage-credit spend and monthly cap", () => {
    const extraUsage = {
      is_enabled: true,
      monthly_limit: 20000,
      used_credits: 9967,
      utilization: 49.835,
      currency: "USD",
      decimal_places: 2,
    };
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 12, resets_at: null },
            extra_usage: extraUsage,
          },
        },
      }).limits.extraUsage,
    ).toEqual({
      checkedAt,
      isEnabled: true,
      monthlyLimit: 200,
      usedCredits: 99.67,
      utilization: 49.835,
      currency: "USD",
    });
  });

  it.each([
    { decimal_places: undefined, expected: 10 },
    { decimal_places: 0, expected: 1000 },
    { decimal_places: 3, expected: 1 },
    { decimal_places: -1, expected: 10 },
  ])("normalizes money with decimal_places=$decimal_places", ({ decimal_places, expected }) => {
    const extraUsage = {
      is_enabled: true,
      monthly_limit: null,
      used_credits: 1000,
      utilization: null,
      decimal_places,
    };
    const { limits } = claudeUsageResponseToLimits({
      checkedAt,
      response: { rate_limits_available: true, rate_limits: { extra_usage: extraUsage } },
    });
    expect(limits.extraUsage?.usedCredits).toBe(expected);
    expect(limits.extraUsage?.monthlyLimit).toBeNull();
  });

  it("maps the session, weekly, and model-scoped weekly windows", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 54, resets_at: "2026-07-18T14:39:00Z" },
            seven_day: { utilization: 18.4, resets_at: "2026-07-24T08:59:00+00:00" },
            seven_day_opus: { utilization: 3, resets_at: null },
            // Newer CLIs add this on top of the typed keys; the pinned SDK
            // typings do not know it yet.
            ...({
              model_scoped: [
                { display_name: "Fable", utilization: 73, resets_at: "2026-07-24T08:59:00Z" },
                { display_name: "Ghost", utilization: null, resets_at: null },
              ],
            } as object),
            extra_usage: {
              is_enabled: false,
              monthly_limit: null,
              used_credits: null,
              utilization: null,
            },
          },
        },
      }),
    ).toEqual({
      names: { overageIncluded: "Fable" },
      limits: {
        checkedAt,
        extraUsage: {
          checkedAt,
          isEnabled: false,
          monthlyLimit: null,
          usedCredits: null,
          utilization: null,
        },
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 54,
            windowDurationMins: 300,
            resetsAt: "2026-07-18T14:39:00.000Z",
          },
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 18.4,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "Weekly · Fable",
            usedPercent: 73,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
        ],
      },
    });
  });

  it("names the overage-included bucket only from a scoped entry that drew a row", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            ...({
              model_scoped: [
                { display_name: "Ghost", utilization: null, resets_at: null },
                { display_name: "Fable", utilization: 5, resets_at: null },
              ],
            } as object),
          },
        },
      }).names,
    ).toEqual({ overageIncluded: "Fable" });
  });

  it("reports API key and Bedrock accounts as unsupported", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: { rate_limits_available: false, rate_limits: null },
      }).limits,
    ).toEqual({ checkedAt, windows: [], unavailable: { reason: "unsupported" } });
  });

  it("skips a window the endpoint reports without a utilization", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: null, resets_at: null },
            seven_day: { utilization: 250, resets_at: null },
          },
        },
      }).limits.windows,
    ).toEqual([
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        windowDurationMins: 10080,
      },
    ]);
  });
});

describe("claudeRateLimitEventToUpdate", () => {
  it("scales the 0–1 utilization and epoch-second reset onto the probe's window id", () => {
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 0.85,
          resetsAt: 1_784_000_000,
        },
        noNames,
      ),
    ).toEqual({
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 85,
          windowDurationMins: 10080,
          resetsAt: "2026-07-14T03:33:20.000Z",
        },
      ],
    });
  });

  it("lands the streamed overage-included bucket on the row the probe named", () => {
    const event = {
      status: "allowed",
      rateLimitType: "seven_day_overage_included" as never,
      utilization: 0.4,
    } as const;
    // No probe has named the bucket yet: guessing would open a stray row.
    expect(claudeRateLimitEventToUpdate(event, noNames)).toBeUndefined();
    expect(claudeRateLimitEventToUpdate(event, { overageIncluded: "Fable" })).toEqual({
      windows: [
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          usedPercent: 40,
          windowDurationMins: 10080,
        },
      ],
    });
  });

  it("ignores windows the page does not render and events without a utilization", () => {
    expect(
      claudeRateLimitEventToUpdate(
        { status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.1 },
        noNames,
      ),
    ).toBeUndefined();
    expect(
      claudeRateLimitEventToUpdate({ status: "rejected", rateLimitType: "five_hour" }, noNames),
    ).toBeUndefined();
  });
});
