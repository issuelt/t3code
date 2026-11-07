const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { factor, jobUsage, candidateFiles, tally } = require("./blacksmith-usage.cjs");

const now = Date.UTC(2026, 10, 15, 12);
const at = (minutesAgo, seconds = 0) =>
  new Date(now - minutesAgo * 60_000 + seconds * 1000).toISOString();

const job = (overrides = {}) => ({
  id: 1,
  runner_name: "blacksmith-8vcpu-ubuntu-2404-rt7f2xh744e6l44c",
  labels: ["blacksmith-8vcpu-ubuntu-2404"],
  started_at: at(10),
  completed_at: at(5),
  ...overrides,
});

test("factors follow the label", () => {
  assert.equal(factor("blacksmith-2vcpu-ubuntu-2404"), 1);
  assert.equal(factor("blacksmith-8vcpu-ubuntu-2404"), 4);
  assert.equal(factor("blacksmith-8vcpu-windows-2025"), 8);
  assert.equal(factor("blacksmith-12vcpu-macos-26"), 120);
  assert.equal(factor("blacksmith-16vcpu-ubuntu-2404-arm"), 5);
  assert.equal(factor("blacksmith-2vcpu-ubuntu-2404-arm"), 0.625);
  assert.equal(factor("blacksmith-8vcpu-ubuntu-2404-armx1y2z3"), 4);
  assert.equal(factor("blacksmith-8vcpu-ubuntu-2404-arm-x1y2z3"), 2.5);
  assert.equal(factor("blacksmith-0vcpu-ubuntu-2404"), null);
  assert.equal(factor("ubuntu-24.04"), null);
});

test("minutes round up, with at least 1", () => {
  assert.equal(jobUsage(job({ started_at: at(5), completed_at: at(5, 1) }), now), 4);
  assert.equal(jobUsage(job({ started_at: at(5), completed_at: at(5) }), now), 4);
  assert.equal(jobUsage(job({ started_at: at(5), completed_at: at(4) }), now), 4);
  assert.equal(jobUsage(job({ started_at: at(5), completed_at: at(4, 1) }), now), 8);
  assert.equal(jobUsage(job({ started_at: at(10), completed_at: at(5) }), now), 20);
});

test("a running job counts its time so far", () => {
  assert.equal(jobUsage(job({ started_at: at(2, -30), completed_at: null }), now), 12);
});

test("a skipped job keeps its label but has no runner, so it counts nothing", () => {
  assert.equal(jobUsage(job({ runner_name: null }), now), 0);
  assert.equal(jobUsage(job({ started_at: null }), now), 0);
});

test("hosted and VM104 jobs count nothing", () => {
  assert.equal(
    jobUsage(job({ runner_name: "GitHub Actions 1000001285", labels: ["ubuntu-24.04"] }), now),
    0,
  );
  assert.equal(
    jobUsage(job({ runner_name: "ci-ubuntu104-1", labels: ["issuelt-t3code-ubuntu24"] }), now),
    0,
  );
});

test("a Blacksmith runner name alone is enough", () => {
  assert.equal(jobUsage(job({ labels: [] }), now), 20);
});

test("a Blacksmith job without a known factor fails the tally", () => {
  assert.throws(
    () => jobUsage(job({ runner_name: "blacksmith-x", labels: ["blacksmith-gpu"] }), now),
    /no known factor/,
  );
});

test("candidate workflows name Blacksmith or call a workflow that does", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacksmith-usage-"));
  fs.writeFileSync(path.join(dir, "uses.yml"), "runs-on: blacksmith-2vcpu-ubuntu-2404\n");
  fs.writeFileSync(path.join(dir, "var.yml"), "runs-on: ${{ vars.BLACKSMITH_LINUX_LABEL }}\n");
  fs.writeFileSync(
    path.join(dir, "caller.yml"),
    "uses: issuelt/t3code/.github/workflows/var.yml@main\n",
  );
  fs.writeFileSync(path.join(dir, "outer.yml"), "uses: ./.github/workflows/caller.yml\n");
  fs.writeFileSync(path.join(dir, "hosted.yml"), "runs-on: ubuntu-24.04\n");
  fs.writeFileSync(path.join(dir, "notes.md"), "blacksmith\n");
  fs.writeFileSync(path.join(dir, "blacksmith-usage.yml"), "runs-on: ubuntu-24.04\n");
  assert.deepEqual(candidateFiles(dir), [
    ".github/workflows/caller.yml",
    ".github/workflows/outer.yml",
    ".github/workflows/uses.yml",
    ".github/workflows/var.yml",
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A fake API with two active candidate workflows, one disabled candidate, and one non-candidate.
function api({ runs = {}, jobs = {}, totals = {}, workflows: extra = [] } = {}) {
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    if (url === "/actions/workflows?per_page=100") {
      return {
        total_count: 4 + extra.length,
        workflows: [
          { id: 1, path: ".github/workflows/fork-ci.yml", state: "active" },
          { id: 2, path: ".github/workflows/fork-release.yml", state: "active" },
          { id: 3, path: ".github/workflows/release.yml", state: "disabled_manually" },
          { id: 4, path: ".github/workflows/pr-size.yml", state: "active" },
          ...extra,
        ],
      };
    }
    const runsMatch =
      /^\/actions\/workflows\/(\d+)\/runs\?created=%3E%3D2026-10-01T00%3A00%3A00Z&exclude_pull_requests=true&per_page=100&page=(\d+)$/.exec(
        url,
      );
    if (runsMatch) {
      const list = runs[runsMatch[1]] ?? [];
      const page = Number(runsMatch[2]);
      return {
        total_count: totals[runsMatch[1]] ?? list.length,
        workflow_runs: list.slice((page - 1) * 100, page * 100),
      };
    }
    const jobsMatch = /^\/actions\/runs\/(\d+)\/jobs\?filter=all&per_page=100&page=(\d+)$/.exec(
      url,
    );
    if (jobsMatch) {
      const list = jobs[jobsMatch[1]] ?? [];
      const page = Number(jobsMatch[2]);
      return { total_count: list.length, jobs: list.slice((page - 1) * 100, page * 100) };
    }
    throw new Error(`GET ${url} returned 404`);
  };
  return { request, calls };
}

const files = [
  ".github/workflows/fork-ci.yml",
  ".github/workflows/fork-release.yml",
  ".github/workflows/release.yml",
];

test("the tally sums candidate workflows in any state and caches completed runs", async () => {
  const fake = api({
    runs: {
      1: [
        { id: 10, status: "completed", run_attempt: 1 },
        { id: 11, status: "in_progress", run_attempt: 1 },
      ],
      2: [{ id: 20, status: "completed", run_attempt: 2 }],
    },
    jobs: {
      10: [job(), job({ runner_name: "GitHub Actions 1", labels: ["ubuntu-24.04"] })],
      11: [job({ started_at: at(1), completed_at: null })],
      20: [
        job({
          labels: ["blacksmith-8vcpu-windows-2025"],
          runner_name: "blacksmith-8vcpu-windows-2025-a",
        }),
        job({ runner_name: null }),
      ],
    },
  });
  const result = await tally({ request: fake.request, files, previous: null, now });
  assert.equal(result.month, "2026-11");
  assert.equal(result.used, 20 + 4 + 40);
  assert.equal(result.complete, true);
  assert.equal(result.computed_at, "2026-11-15T12:00:00Z");
  assert.deepEqual(result.workflows, {
    ".github/workflows/fork-ci.yml": 24,
    ".github/workflows/fork-release.yml": 40,
    ".github/workflows/release.yml": 0,
  });
  assert.deepEqual(result.runs, { 10: { attempt: 1, used: 20 }, 20: { attempt: 2, used: 40 } });
  assert.equal(result.calls, 7);

  // The next hour reuses runs 10 and 20, and fetches run 11 again because it was still running.
  const next = api({
    runs: {
      1: [
        { id: 10, status: "completed", run_attempt: 1 },
        { id: 11, status: "completed", run_attempt: 1 },
      ],
      2: [
        { id: 20, status: "completed", run_attempt: 2 },
        { id: 21, status: "completed", run_attempt: 1 },
      ],
    },
    jobs: { 11: [job({ started_at: at(3), completed_at: at(1) })], 21: [] },
  });
  const again = await tally({ request: next.request, files, previous: result, now });
  assert.equal(again.used, 20 + 8 + 40);
  assert.deepEqual(
    next.calls.filter((url) => url.startsWith("/actions/runs/")),
    [
      "/actions/runs/11/jobs?filter=all&per_page=100&page=1",
      "/actions/runs/21/jobs?filter=all&per_page=100&page=1",
    ],
  );
});

test("a re-run attempt is counted again", async () => {
  const previous = { month: "2026-11", runs: { 10: { attempt: 1, used: 20 } } };
  const fake = api({
    runs: { 1: [{ id: 10, status: "completed", run_attempt: 2 }] },
    jobs: { 10: [job(), job()] },
  });
  const result = await tally({ request: fake.request, files, previous, now });
  assert.equal(result.used, 40);
  assert.deepEqual(result.runs, { 10: { attempt: 2, used: 40 } });
});

test("last month's cache is ignored", async () => {
  const previous = { month: "2026-10", runs: { 10: { attempt: 1, used: 999 } } };
  const fake = api({
    runs: { 1: [{ id: 10, status: "completed", run_attempt: 1 }] },
    jobs: { 10: [job()] },
  });
  const result = await tally({ request: fake.request, files, previous, now });
  assert.equal(result.used, 20);
});

test("fractional factors round the month's total up", async () => {
  const arm = job({
    labels: ["blacksmith-2vcpu-ubuntu-2404-arm"],
    runner_name: "blacksmith-2vcpu-ubuntu-2404-arm-a",
  });
  const fake = api({
    runs: { 1: [{ id: 10, status: "completed", run_attempt: 1 }] },
    jobs: { 10: [arm] },
  });
  const result = await tally({ request: fake.request, files, previous: null, now });
  assert.equal(result.used, Math.ceil(5 * 0.625));
});

test("runs and jobs past 100 read the next page", async () => {
  const many = Array.from({ length: 101 }, (_, i) => ({
    id: 1000 + i,
    status: "completed",
    run_attempt: 1,
  }));
  const jobs = Object.fromEntries(many.map((run) => [run.id, []]));
  jobs[1000] = Array.from({ length: 101 }, () => job());
  const fake = api({ runs: { 1: many }, jobs });
  const result = await tally({ request: fake.request, files, previous: null, now });
  assert.equal(result.used, 101 * 20);
  // The workflow list, two pages of runs, 102 jobs pages, and two other workflows' empty runs pages.
  assert.equal(result.calls, 1 + 2 + 102 + 2);
});

test("the call budget stops the tally as incomplete and keeps what it counted", async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    id: 1000 + i,
    status: "completed",
    run_attempt: 1,
  }));
  const jobs = Object.fromEntries(many.map((run) => [run.id, [job()]]));
  const fake = api({ runs: { 1: many }, jobs });
  const previous = { month: "2026-11", runs: { 1009: { attempt: 1, used: 20 } } };
  const result = await tally({ request: fake.request, files, previous, now, maxCalls: 5 });
  assert.equal(result.complete, false);
  assert.equal(result.calls, 5);
  assert.deepEqual(Object.keys(result.runs).sort(), ["1000", "1001", "1002", "1009"]);

  const rest = await tally({
    request: api({ runs: { 1: many }, jobs }).request,
    files,
    previous: result,
    now,
  });
  assert.equal(rest.complete, true);
  assert.equal(rest.used, 10 * 20);
  assert.equal(rest.calls, 1 + 1 + 6 + 2);
});

test("a failed call fails the tally", async () => {
  const fake = api({ runs: { 1: [{ id: 10, status: "completed", run_attempt: 1 }] } });
  const request = async (url) =>
    url.includes("/jobs") ? Promise.reject(new Error("GET returned 500")) : fake.request(url);
  await assert.rejects(tally({ request, files, previous: null, now }), /500/);
});

test("a disabled workflow still counts", async () => {
  const fake = api({
    runs: { 3: [{ id: 30, status: "completed", run_attempt: 1 }] },
    jobs: { 30: [job()] },
  });
  const result = await tally({ request: fake.request, files, previous: null, now });
  assert.equal(result.used, 20);
  assert.equal(result.workflows[".github/workflows/release.yml"], 20);
});

test("a workflow that stops naming Blacksmith keeps counting after it spent this month", async () => {
  const previous = {
    month: "2026-11",
    workflows: { ".github/workflows/pr-size.yml": 20 },
    runs: { 40: { attempt: 1, used: 20 } },
  };
  const fake = api({ runs: { 4: [{ id: 40, status: "completed", run_attempt: 1 }] } });
  const result = await tally({ request: fake.request, files, previous, now });
  assert.equal(result.used, 20);
  assert.equal(result.workflows[".github/workflows/pr-size.yml"], 20);
});

test("a workflow the API no longer lists keeps its recorded usage", async () => {
  const previous = { month: "2026-11", workflows: { ".github/workflows/gone.yml": 12 }, runs: {} };
  const result = await tally({ request: api().request, files, previous, now });
  assert.equal(result.used, 12);
  assert.equal(result.workflows[".github/workflows/gone.yml"], 12);
});

test("last month's per-workflow usage is not carried over", async () => {
  const previous = { month: "2026-10", workflows: { ".github/workflows/gone.yml": 12 }, runs: {} };
  const result = await tally({ request: api().request, files, previous, now });
  assert.equal(result.used, 0);
});

test("a run created last month counts only the jobs that started this month", async () => {
  const fake = api({
    runs: { 2: [{ id: 20, status: "completed", run_attempt: 2 }] },
    jobs: {
      20: [
        job({ started_at: "2026-10-31T23:00:00Z", completed_at: "2026-10-31T23:10:00Z" }),
        job({ started_at: "2026-10-31T23:55:00Z", completed_at: "2026-11-01T00:05:00Z" }),
        job({ started_at: "2026-11-01T00:00:00Z", completed_at: "2026-11-01T00:05:00Z" }),
      ],
    },
  });
  const result = await tally({ request: fake.request, files, previous: null, now });
  assert.equal(result.used, 20);
});

test("a run listing past 1,000 results marks the tally incomplete", async () => {
  const fake = api({
    runs: { 1: [{ id: 10, status: "completed", run_attempt: 1 }] },
    jobs: { 10: [job()] },
    totals: { 1: 1001 },
  });
  const result = await tally({ request: fake.request, files, previous: null, now });
  assert.equal(result.complete, false);
  assert.equal(result.used, 20);
});
