import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { homeSessionRollReason } from "./homeSessionRoll.ts";

const now = DateTime.makeUnsafe("2026-11-13T12:00:00Z");
const minutesAgo = (minutes: number) => DateTime.subtract(now, { minutes });

it.each([
  { name: "first turn", lastTurnAt: null, usedTokens: 900_000, expected: null },
  { name: "warm and small", lastTurnAt: minutesAgo(4), usedTokens: 40_000, expected: null },
  {
    name: "cache expired",
    lastTurnAt: minutesAgo(6),
    usedTokens: 40_000,
    expected: "cache_expired",
  },
  {
    name: "half full",
    lastTurnAt: minutesAgo(1),
    usedTokens: 100_000,
    expected: "context_half_full",
  },
  { name: "unknown usage", lastTurnAt: minutesAgo(1), usedTokens: undefined, expected: null },
] as const)("$name", ({ lastTurnAt, usedTokens, expected }) => {
  expect(homeSessionRollReason({ lastTurnAt, usedTokens, contextWindow: 200_000, now })).toBe(
    expected,
  );
});
