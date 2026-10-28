import { describe, expect, it } from "vite-plus/test";
import type { ProjectCiResult } from "@t3tools/contracts";
import { orderRuns } from "./ProjectCiPage";

function run(
  id: string,
  status: string,
  conclusion: string | null,
  createdAt: string,
): ProjectCiResult["runs"][number] {
  return {
    id,
    name: id,
    status,
    conclusion,
    createdAt,
    updatedAt: createdAt,
    url: "https://example.com",
    branch: null,
    sha: "abc",
  };
}

describe("CI run ordering", () => {
  it("includes GitLab pipelines waiting for execution or resources", () => {
    const rows = ["created", "waiting_for_resource"].map((status) => ({
      run: run(status, status, null, "2026-01-01"),
    }));
    expect(orderRuns(rows, "active")).toEqual(rows);
  });

  it("places active runs first across projects and filters by outcome", () => {
    const rows = [
      { project: "a", run: run("failed", "completed", "failure", "2026-01-03") },
      { project: "b", run: run("queued", "queued", null, "2026-01-01") },
      { project: "a", run: run("running", "in_progress", null, "2026-01-02") },
      { project: "b", run: run("passed", "completed", "success", "2026-01-04") },
    ];
    expect(orderRuns(rows, "all").map(({ run }) => run.id)).toEqual([
      "running",
      "queued",
      "passed",
      "failed",
    ]);
    expect(orderRuns(rows, "failed").map(({ run }) => run.id)).toEqual(["failed"]);
    expect(orderRuns(rows, "active").map(({ run }) => run.id)).toEqual(["running", "queued"]);
  });
});
