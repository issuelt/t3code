import { expect, it } from "vite-plus/test";

import { homeContextFull } from "./homeSessionRoll.ts";

it.each([
  { name: "small", usedTokens: 40_000, contextWindow: 200_000, expected: false },
  { name: "half full", usedTokens: 100_000, contextWindow: 200_000, expected: true },
  {
    name: "past a lower auto-compact threshold",
    usedTokens: 70_000,
    contextWindow: 200_000,
    autoCompactThreshold: 67_000,
    expected: true,
  },
  {
    name: "below both limits",
    usedTokens: 60_000,
    contextWindow: 200_000,
    autoCompactThreshold: 67_000,
    expected: false,
  },
  { name: "unknown usage", usedTokens: undefined, contextWindow: 200_000, expected: false },
  { name: "unknown window", usedTokens: 900_000, contextWindow: undefined, expected: false },
] as const)("$name", (input) => {
  expect(
    homeContextFull({
      usedTokens: input.usedTokens,
      contextWindow: input.contextWindow,
      autoCompactThreshold:
        "autoCompactThreshold" in input ? input.autoCompactThreshold : undefined,
    }),
  ).toBe(input.expected);
});
