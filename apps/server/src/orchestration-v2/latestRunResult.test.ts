import { expect, it } from "@effect/vitest";

import { lastReportLine } from "./latestRunResult.ts";

it.each([
  {
    text: "Done.\nPR https://example.test/pull/12, head abc123\n\n",
    line: "PR https://example.test/pull/12, head abc123",
  },
  { text: "Output:\n```sh\nvp test\n```\n", line: "vp test" },
  { text: "  \n\n", line: null },
  { text: "x".repeat(300), line: `${"x".repeat(279)}…` },
])("the last line of $text is $line", ({ text, line }) => {
  expect(lastReportLine(text)).toBe(line);
});
