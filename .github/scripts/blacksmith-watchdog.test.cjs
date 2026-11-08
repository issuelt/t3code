const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { decide, watch, report, parseLabels, ApiError } = require("./blacksmith-watchdog.cjs");

const script = path.join(__dirname, "blacksmith-watchdog.cjs");
const windows = "blacksmith-4vcpu-windows-2025";
const linux = "blacksmith-4vcpu-ubuntu-2404";
const start = Date.UTC(2026, 10, 15, 12);
const iso = (ms) => new Date(ms).toISOString();

const job = (overrides = {}) => ({
  id: 1,
  name: "Build win-x64",
  labels: [windows],
  status: "queued",
  conclusion: null,
  runner_name: null,
  created_at: iso(start),
  ...overrides,
});

// A fake clock that each sleep moves forward, and a request that answers one poll per call.
function harness(polls) {
  let now = start;
  const calls = [];
  const sleeps = [];
  let poll = 0;
  const request = async (method, url) => {
    calls.push(`${method} ${url}`);
    const answer = polls[Math.min(poll, polls.length - 1)];
    poll += 1;
    if (answer instanceof Error) throw answer;
    return { total_count: answer.length, jobs: answer };
  };
  return {
    request,
    calls,
    sleeps,
    clock: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

const run = (h, labels = [windows]) =>
  watch({ request: h.request, runId: "42", attempt: "1", labels, clock: h.clock, sleep: h.sleep });

test("every Blacksmith job started: the watch ends without a stall", async () => {
  const h = harness([
    [job(), job({ id: 2, name: "Build mac-arm64", labels: ["macos-15"] })],
    [job({ status: "in_progress", runner_name: "blacksmith-4vcpu-windows-2025-x" })],
  ]);
  const result = await run(h);
  assert.deepEqual(result.stalled, []);
  assert.equal(h.sleeps.length, 1);
  assert.deepEqual(h.calls, [
    "GET /actions/runs/42/attempts/1/jobs?per_page=100&page=1",
    "GET /actions/runs/42/attempts/1/jobs?per_page=100&page=1",
  ]);
});

test("a job that finished, failed, or left the queue counts as started", async () => {
  for (const done of [
    { status: "completed", conclusion: "cancelled" },
    { status: "in_progress" },
    { status: "queued", conclusion: "failure" },
    { status: "queued", runner_name: "blacksmith-4vcpu-windows-2025-x" },
  ]) {
    const result = await run(harness([[job(done)]]));
    assert.deepEqual(result.stalled, [], JSON.stringify(done));
  }
});

test("one job stalled past 5 minutes: the watch returns it, and only it", async () => {
  const started = job({
    id: 2,
    name: "Build linux-x64",
    labels: [linux],
    status: "in_progress",
    runner_name: "b-1",
  });
  const h = harness([[job(), started]]);
  const result = await run(h, [windows, linux]);
  assert.deepEqual(
    result.stalled.map((j) => j.name),
    ["Build win-x64"],
  );
  // 15 polls at 20 seconds reach 5 minutes; the 16th sees the stall.
  assert.equal(h.sleeps.length, 15);
  assert.ok(h.sleeps.every((ms) => ms === 20_000));
});

test("a job created a minute before the watchdog stalls a minute sooner", async () => {
  const h = harness([[job({ created_at: iso(start - 60_000) })]]);
  const result = await run(h);
  assert.equal(result.stalled.length, 1);
  assert.equal(h.sleeps.length, 12);
});

test("a job that gets a runner at 4 minutes 40 seconds is not stalled", async () => {
  const polls = Array.from({ length: 14 }, () => [job()]);
  polls.push([job({ status: "in_progress", runner_name: "b-1" })]);
  const result = await run(harness(polls));
  assert.deepEqual(result.stalled, []);
});

test("no watched job after the grace minute ends the watch, such as a check on VM104", async () => {
  const h = harness([[job({ labels: ["issuelt-t3code-ubuntu24"] })]]);
  const result = await run(h);
  assert.deepEqual(result.stalled, []);
  assert.equal(h.sleeps.length, 3);
});

test("the API fails: the watch throws and never cancels", async () => {
  const h = harness([new ApiError("GET returned 500", 500)]);
  await assert.rejects(run(h), /500/);
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls.every((call) => call.startsWith("GET ")));
});

test("a 403 fails the watch at once", async () => {
  const h = harness([new ApiError("GET returned 403", 403)]);
  await assert.rejects(run(h), /403/);
  assert.equal(h.calls.length, 1);
});

test("one failed poll between good ones is retried", async () => {
  const h = harness([
    [job()],
    new ApiError("GET returned 502", 502),
    [job({ status: "in_progress", runner_name: "b-1" })],
  ]);
  assert.deepEqual((await run(h)).stalled, []);
});

test("a response without a jobs list fails the watch", async () => {
  const request = async () => ({ total_count: 1 });
  await assert.rejects(
    watch({ request, runId: "42", attempt: "1", labels: [windows], sleep: async () => {} }),
    /no jobs list/,
  );
});

test("decide ignores jobs with other labels", () => {
  const result = decide([job({ labels: ["windows-2025"] })], [windows], start + 600_000, new Map());
  assert.deepEqual(result, { watched: [], waiting: [], stalled: [] });
});

test("the report writes the marker, the summary, the outputs, and the error line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacksmith-watchdog-"));
  const outputFile = path.join(dir, "output");
  const summaryFile = path.join(dir, "summary");
  const labels = report({
    stalled: [job()],
    labels: [windows, linux],
    runId: "42",
    attempt: "2",
    dir: path.join(dir, "stalled"),
    outputFile,
    summaryFile,
  });
  assert.deepEqual(labels, [windows]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "stalled/blacksmith-stalled.json"))), {
    run_id: 42,
    run_attempt: 2,
    labels: [windows],
    jobs: [{ id: 1, name: "Build win-x64", labels: [windows] }],
  });
  assert.equal(fs.readFileSync(outputFile, "utf8"), `stalled=true\nlabels=${windows}\n`);
  assert.match(fs.readFileSync(summaryFile, "utf8"), /Build win-x64.*waited 5 minutes/);

  const clean = path.join(dir, "clean");
  report({
    stalled: [],
    labels: [windows],
    runId: "42",
    attempt: "1",
    dir: path.join(dir, "none"),
    outputFile: clean,
  });
  assert.equal(fs.readFileSync(clean, "utf8"), "stalled=false\n");
  assert.ok(!fs.existsSync(path.join(dir, "none")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("labels must be Blacksmith labels", () => {
  assert.deepEqual(parseLabels(` ${windows}  ${linux} `), [windows, linux]);
  assert.throws(() => parseLabels(""), /empty/);
  assert.throws(() => parseLabels("ubuntu-24.04"), /not a Blacksmith label/);
  assert.throws(() => parseLabels('blacksmith-4vcpu-ubuntu-2404"x'), /not a Blacksmith label/);
});

// The command line against a local server: a failed watch exits 1 with no stalled output and no cancel.
test("the command exits 1 on an API failure and posts nothing", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(403).end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacksmith-watchdog-"));
  const output = path.join(dir, "output");
  fs.writeFileSync(output, "");
  const result = await new Promise((resolve) => {
    const child = require("node:child_process").spawn(
      process.execPath,
      [script, "watch", path.join(dir, "stalled")],
      {
        env: {
          PATH: process.env.PATH,
          BLACKSMITH_LABELS: windows,
          GH_TOKEN: "ghs_test",
          GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
          GITHUB_REPOSITORY: "issuelt/t3code",
          GITHUB_RUN_ID: "42",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_OUTPUT: output,
        },
      },
    );
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("close", (status) => resolve({ status, log }));
  });
  server.close();
  assert.equal(result.status, 1, result.log);
  assert.match(result.log, /::error::Blacksmith watchdog failed: GET .* returned 403/);
  assert.equal(fs.readFileSync(output, "utf8"), "");
  assert.deepEqual(seen, [
    "GET /repos/issuelt/t3code/actions/runs/42/attempts/1/jobs?per_page=100&page=1",
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the command refuses a run id that is not a number", () => {
  const result = spawnSync(process.execPath, [script, "cancel"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, GITHUB_RUN_ID: "1/../2", GITHUB_RUN_ATTEMPT: "1" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /must be numbers/);
});
