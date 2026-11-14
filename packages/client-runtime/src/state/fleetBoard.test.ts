import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { buildFleetBoard } from "./fleetBoard.ts";

const atlas = EnvironmentId.make("env-atlas");
const birch = EnvironmentId.make("env-birch");

function shell(id: string, overrides: Partial<Parameters<typeof buildFleetBoard>[0][number]> = {}) {
  return {
    environmentId: atlas,
    id: ThreadId.make(id),
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    homeJob: null,
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

it("groups active chiefs of staff by job, newest activity first, and marks offline rows", () => {
  const board = buildFleetBoard(
    [
      shell("home-launched:a", { homeJob: "Release", updatedAt: "2026-11-03T00:00:00.000Z" }),
      shell("home-launched:b", {
        homeJob: "Docs",
        environmentId: birch,
        updatedAt: "2026-11-05T00:00:00.000Z",
      }),
      shell("home-launched:c", { homeJob: "Release", updatedAt: "2026-11-04T00:00:00.000Z" }),
      shell("home-launched:d", { updatedAt: "2026-11-02T00:00:00.000Z" }),
      shell("thread:own", { homeJob: "Release", updatedAt: "2026-11-09T00:00:00.000Z" }),
      shell("home-launched:child", {
        lineage: {
          rootThreadId: ThreadId.make("home-launched:a"),
          parentThreadId: ThreadId.make("home-launched:a"),
          relationshipToParent: "subagent",
        },
      }),
      shell("home-launched:settled", { settledOverride: "settled" }),
      shell("home-launched:archived", { archivedAt: "2026-11-01T00:00:00.000Z" }),
    ],
    new Set([atlas]),
  );
  expect(
    board.map((group) => ({
      job: group.job,
      chiefs: group.chiefs.map((chief) => [chief.shell.id, chief.environmentConnected]),
    })),
  ).toEqual([
    { job: "Docs", chiefs: [["home-launched:b", false]] },
    {
      job: "Release",
      chiefs: [
        ["home-launched:c", true],
        ["home-launched:a", true],
      ],
    },
    { job: null, chiefs: [["home-launched:d", true]] },
  ]);
});
