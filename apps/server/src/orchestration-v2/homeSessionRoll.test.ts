import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { homeSessionRollReason } from "./homeSessionRoll.ts";

const now = DateTime.makeUnsafe("2026-11-13T12:00:00Z");
const minutesAgo = (minutes: number) => DateTime.subtract(now, { minutes });

it.each([
  {
    name: "first turn",
    lastTurnAt: null,
    usedTokens: 900_000,
    contextWindow: 200_000,
    expected: null,
  },
  {
    name: "small and recently active",
    lastTurnAt: minutesAgo(59),
    usedTokens: 40_000,
    contextWindow: 200_000,
    expected: null,
  },
  {
    name: "idle for an hour",
    lastTurnAt: minutesAgo(60),
    usedTokens: 40_000,
    contextWindow: 200_000,
    expected: "idle",
  },
  {
    name: "idle for an hour with unknown usage",
    lastTurnAt: minutesAgo(60),
    usedTokens: undefined,
    contextWindow: undefined,
    expected: "idle",
  },
  {
    name: "clock skew before last turn",
    lastTurnAt: DateTime.add(now, { minutes: 90 }),
    usedTokens: 40_000,
    contextWindow: 200_000,
    expected: null,
  },
  {
    name: "half full",
    lastTurnAt: minutesAgo(1),
    usedTokens: 100_000,
    contextWindow: 200_000,
    expected: "context_full",
  },
  {
    name: "past a lower auto-compact threshold",
    lastTurnAt: minutesAgo(1),
    usedTokens: 70_000,
    contextWindow: 200_000,
    autoCompactThreshold: 67_000,
    expected: "context_full",
  },
  {
    name: "below both limits",
    lastTurnAt: minutesAgo(1),
    usedTokens: 60_000,
    contextWindow: 200_000,
    autoCompactThreshold: 67_000,
    expected: null,
  },
  {
    name: "unknown usage while active",
    lastTurnAt: minutesAgo(1),
    usedTokens: undefined,
    contextWindow: 200_000,
    expected: null,
  },
  {
    name: "unknown window while active",
    lastTurnAt: minutesAgo(1),
    usedTokens: 900_000,
    contextWindow: undefined,
    expected: null,
  },
] as const)("$name", (input) => {
  expect(
    homeSessionRollReason({
      lastTurnAt: input.lastTurnAt,
      usedTokens: input.usedTokens,
      contextWindow: input.contextWindow,
      autoCompactThreshold:
        "autoCompactThreshold" in input ? input.autoCompactThreshold : undefined,
      now,
    }),
  ).toBe(input.expected);
});
