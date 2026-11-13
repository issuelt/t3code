import { expect, it } from "vite-plus/test";

import { homeContextHalfFull } from "./homeSessionRoll.ts";

it.each([
  { name: "small", usedTokens: 40_000, contextWindow: 200_000, expected: false },
  { name: "half full", usedTokens: 100_000, contextWindow: 200_000, expected: true },
  { name: "unknown usage", usedTokens: undefined, contextWindow: 200_000, expected: false },
  { name: "unknown window", usedTokens: 900_000, contextWindow: undefined, expected: false },
] as const)("$name", ({ usedTokens, contextWindow, expected }) => {
  expect(homeContextHalfFull({ usedTokens, contextWindow })).toBe(expected);
});
