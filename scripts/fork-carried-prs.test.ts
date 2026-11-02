import { assert, describe, it } from "@effect/vitest";

import { classifyCarriedPr } from "./fork-carried-prs.ts";

const taken = "a".repeat(40);
const later = "b".repeat(40);
const other = "c".repeat(40);

function pullRequest(
  state: "OPEN" | "CLOSED" | "MERGED",
  headRefOid: string,
  oids: ReadonlyArray<string>,
  totalCount = oids.length,
) {
  return {
    state,
    headRefOid,
    commits: { totalCount, nodes: oids.map((oid) => ({ commit: { oid } })) },
  } as const;
}

describe("classifyCarriedPr", () => {
  it("separates every upstream state", () => {
    const cases = [
      [pullRequest("OPEN", taken, [other, taken]), { kind: "unchanged" }],
      [pullRequest("OPEN", later, [taken, other, later]), { kind: "new-commits", newCommits: 2 }],
      [
        pullRequest("OPEN", later, [other, later]),
        { kind: "new-commits", newCommits: "rewritten" },
      ],
      [
        pullRequest("OPEN", later, [other, later], 150),
        { kind: "new-commits", newCommits: "unknown" },
      ],
      [pullRequest("MERGED", taken, [taken]), { kind: "merged" }],
      [pullRequest("CLOSED", taken, [taken]), { kind: "closed-unmerged" }],
    ] as const;
    for (const [pr, expected] of cases) {
      assert.deepStrictEqual(classifyCarriedPr({ takenSha: taken }, pr), expected);
    }
  });

  it("stays quiet on an accepted closed PR until its head moves", () => {
    const entry = { takenSha: taken, closedUpstream: true } as const;
    assert.deepStrictEqual(classifyCarriedPr(entry, pullRequest("CLOSED", taken, [taken])), {
      kind: "unchanged",
    });
    assert.deepStrictEqual(classifyCarriedPr(entry, pullRequest("CLOSED", later, [taken, later])), {
      kind: "closed-unmerged",
    });
  });
});
