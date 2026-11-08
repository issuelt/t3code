const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const script = path.join(__dirname, "route-blacksmith.sh");
const api = "https://api.test";
const githubToken = "ghs_workflow_token";
// 2026-11-15T12:00:00Z
const now = Date.UTC(2026, 10, 15, 12) / 1000;
const iso = (seconds) => new Date(seconds * 1000).toISOString().replace(/\.\d+Z$/, "Z");

const linux = "blacksmith-8vcpu-ubuntu-2404";
const android = "blacksmith-16vcpu-ubuntu-2404";
const windows = "blacksmith-8vcpu-windows-2025";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "route-blacksmith-"));

// The fake curl answers from ROUTE_FIXTURES and fails like `curl -f` for any URL it has no fixture for.
const bin = path.join(work, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(
  path.join(bin, "curl"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ROUTE_CALLS, JSON.stringify(args) + "\\n");
const url = new URL(args[args.length - 1]);
const key = url.pathname + url.search;
const fixture = JSON.parse(process.env.ROUTE_FIXTURES)[key];
if (!fixture || fixture.status >= 400) {
  process.stderr.write("curl: (22) The requested URL returned error: " + (fixture ? fixture.status : 404) + "\\n");
  process.exit(22);
}
process.stdout.write(fixture.base64 ? Buffer.from(fixture.base64, "base64") : JSON.stringify(fixture.body));
`,
  { mode: 0o755 },
);

function zip(files) {
  const out = path.join(work, `usage-${Math.random().toString(36).slice(2)}.zip`);
  execFileSync("python3", [
    "-I",
    "-c",
    "import json, sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w') as z:\n    for name, text in json.loads(sys.argv[2]).items(): z.writestr(name, text)",
    out,
    JSON.stringify(files),
  ]);
  return fs.readFileSync(out).toString("base64");
}

const usage = (overrides = {}) => ({
  month: "2026-11",
  used: 0,
  complete: true,
  computed_at: iso(now - 1800),
  workflows: {},
  stalled: {},
  ...overrides,
});

const routes = ({
  tally = usage(),
  run = {
    id: 7,
    head_branch: "main",
    event: "schedule",
    head_repository: { full_name: "issuelt/t3code" },
  },
  artifacts = [{ id: 9, name: "blacksmith-usage", expired: false }],
  archive,
  previous,
} = {}) => ({
  ...(previous && {
    "/repos/issuelt/t3code/actions/runs/42/attempts/1/jobs?per_page=100": previous,
  }),
  "/repos/issuelt/t3code/actions/workflows/blacksmith-usage.yml/runs?branch=main&status=success&per_page=1":
    { status: 200, body: { workflow_runs: run ? [run] : [] } },
  "/repos/issuelt/t3code/actions/runs/7/artifacts?name=blacksmith-usage": {
    status: 200,
    body: { artifacts },
  },
  "/repos/issuelt/t3code/actions/artifacts/9/zip": {
    status: 200,
    base64: archive ?? zip({ "blacksmith-usage.json": JSON.stringify(tally) }),
  },
});

function route({
  fixtures = routes(),
  trusted = "true",
  routing = "",
  labels = { linux, android, windows },
  kinds = "linux android windows",
  reserve = "linux android windows",
  token = githubToken,
  attempt = "1",
} = {}) {
  const output = path.join(work, `output-${Math.random().toString(36).slice(2)}`);
  const calls = path.join(work, `calls-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(output, "");
  fs.writeFileSync(calls, "");
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      TRUSTED: trusted,
      BLACKSMITH_ROUTING: routing,
      BLACKSMITH_KINDS: kinds,
      BLACKSMITH_RESERVE_KINDS: reserve,
      BLACKSMITH_LINUX_LABEL: labels.linux ?? "",
      BLACKSMITH_ANDROID_LABEL: labels.android ?? "",
      BLACKSMITH_WINDOWS_LABEL: labels.windows ?? "",
      GH_TOKEN: token,
      GITHUB_API_URL: api,
      GITHUB_REPOSITORY: "issuelt/t3code",
      GITHUB_OUTPUT: output,
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: attempt,
      ROUTE_NOW: String(now),
      ROUTE_FIXTURES: JSON.stringify(fixtures),
      ROUTE_CALLS: calls,
    },
  });
  const outputs = Object.fromEntries(
    fs
      .readFileSync(output, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  return {
    status: result.status,
    log: result.stdout + result.stderr,
    outputs,
    calls: fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
  };
}

const none = { blacksmith_linux: "", blacksmith_android: "", blacksmith_windows: "" };
const all = { blacksmith_linux: linux, blacksmith_android: android, blacksmith_windows: windows };

// Reservations are timeout-minutes * factor: linux 8 vCPU is 60 * 4 = 240, android
// 16 vCPU is 90 * 8 = 720, windows 8 vCPU is 60 * 4 * 2 = 480. They add up in the
// order linux, android, windows while used + 600 + reserved <= 2400.
const table = [
  ["nothing used", {}, all, "used 0 of 2400"],
  [
    "all three kinds exactly at the budget",
    { fixtures: routes({ tally: usage({ used: 360 }) }) },
    all,
    "used 360",
  ],
  [
    "all three kinds one minute over leaves windows out",
    { fixtures: routes({ tally: usage({ used: 361 }) }) },
    { ...none, blacksmith_linux: linux, blacksmith_android: android },
    "60 minutes of blacksmith-8vcpu-windows-2025 on top of the kinds before it would pass",
  ],
  [
    "android does not fit after linux, but windows still does",
    { fixtures: routes({ tally: usage({ used: 1080 }) }) },
    { ...none, blacksmith_linux: linux, blacksmith_windows: windows },
    "90 minutes of blacksmith-16vcpu-ubuntu-2404 on top of the kinds before it would pass",
  ],
  [
    "linux exactly at the budget",
    { fixtures: routes({ tally: usage({ used: 1560 }) }) },
    { ...none, blacksmith_linux: linux },
    "would pass the budget",
  ],
  [
    "linux one minute over",
    { fixtures: routes({ tally: usage({ used: 1561 }) }) },
    none,
    "60 minutes of blacksmith-8vcpu-ubuntu-2404 on top of the kinds before it would pass",
  ],
  [
    "android alone exactly at the budget",
    { labels: { android }, fixtures: routes({ tally: usage({ used: 1080 }) }) },
    { ...none, blacksmith_android: android },
    "used 1080",
  ],
  [
    "android alone one minute over",
    { labels: { android }, fixtures: routes({ tally: usage({ used: 1081 }) }) },
    none,
    "would pass the budget",
  ],
  ["untrusted event, such as a fork pull request", { trusted: "false" }, none, "untrusted event"],
  ["BLACKSMITH_ROUTING=off", { routing: "off" }, none, "BLACKSMITH_ROUTING is off"],
  ["BLACKSMITH_ROUTING=on", { routing: "on" }, all, "used 0"],
  ["no labels", { labels: {} }, none, "no valid label"],
  [
    "a label only for a kind this call does not decide",
    { labels: { windows }, kinds: "linux" },
    none,
    "no valid label",
  ],
  ["an unknown kind", { kinds: "linux macos" }, none, "BLACKSMITH_KINDS is not valid"],
  ["a repeated kind", { reserve: "linux linux" }, none, "BLACKSMITH_RESERVE_KINDS is not valid"],
  ["no reserved kinds", { reserve: "" }, none, "BLACKSMITH_RESERVE_KINDS is not valid"],
  ["no kinds to decide", { kinds: "" }, none, "BLACKSMITH_KINDS is not valid"],
  [
    "a kind to decide that is not reserved",
    { kinds: "linux android", reserve: "linux" },
    none,
    "BLACKSMITH_KINDS has android, which BLACKSMITH_RESERVE_KINDS lacks",
  ],
  [
    "only the Windows label",
    { labels: { windows } },
    { ...none, blacksmith_windows: windows },
    "BLACKSMITH_LINUX_LABEL is empty",
  ],
  [
    "an invalid label next to a valid one",
    { labels: { linux: "blacksmith-8vcpu-macos-15", windows } },
    { ...none, blacksmith_windows: windows },
    "BLACKSMITH_LINUX_LABEL is not a supported label",
  ],
  [
    "a Linux label for Windows",
    { labels: { linux, windows: "blacksmith-8vcpu-ubuntu-2404" } },
    { ...none, blacksmith_linux: linux },
    "BLACKSMITH_WINDOWS_LABEL is not a supported label",
  ],
  [
    "a Windows label for Linux and Android",
    { labels: { linux: windows, android: windows, windows } },
    { ...none, blacksmith_windows: windows },
    "BLACKSMITH_ANDROID_LABEL is not a supported label",
  ],
  [
    "a label that tries to inject JSON",
    { labels: { linux: 'blacksmith-8vcpu-ubuntu-2404","x' } },
    none,
    "no valid label",
  ],
  ["a hosted label", { labels: { linux: "ubuntu-24.04" } }, none, "not a supported label"],
  ["a 0 vCPU label", { labels: { linux: "blacksmith-0vcpu-ubuntu-2404" } }, none, "would pass"],
  ["no GITHUB_TOKEN", { token: "" }, none, "no GITHUB_TOKEN"],
  [
    "a tally 90 minutes and 1 second old",
    { fixtures: routes({ tally: usage({ computed_at: iso(now - 90 * 60 - 1) }) }) },
    none,
    "is stale",
  ],
  [
    "a tally exactly 90 minutes old",
    { fixtures: routes({ tally: usage({ computed_at: iso(now - 90 * 60) }) }) },
    all,
    "used 0",
  ],
  [
    "a tally from the future",
    { fixtures: routes({ tally: usage({ computed_at: iso(now + 3600) }) }) },
    none,
    "is stale",
  ],
  [
    "a tally from last month",
    { fixtures: routes({ tally: usage({ month: "2026-10" }) }) },
    none,
    "for 2026-10, not 2026-11",
  ],
  [
    "an incomplete tally",
    { fixtures: routes({ tally: usage({ complete: false }) }) },
    none,
    "incomplete",
  ],
  [
    "a tally without usage",
    { fixtures: routes({ tally: usage({ used: null }) }) },
    none,
    "no usage",
  ],
  ["no successful tally run", { fixtures: routes({ run: null }) }, none, "no successful"],
  [
    "a tally run from another branch",
    {
      fixtures: routes({
        run: {
          id: 7,
          head_branch: "pr",
          event: "workflow_dispatch",
          head_repository: { full_name: "issuelt/t3code" },
        },
      }),
    },
    none,
    "no successful",
  ],
  [
    "a fork pull request from a branch named main",
    {
      fixtures: routes({
        run: {
          id: 7,
          head_branch: "main",
          event: "pull_request",
          head_repository: { full_name: "someone/t3code" },
        },
      }),
    },
    none,
    "no successful",
  ],
  [
    "a scheduled run from another repository's main",
    {
      fixtures: routes({
        run: {
          id: 7,
          head_branch: "main",
          event: "schedule",
          head_repository: { full_name: "someone/t3code" },
        },
      }),
    },
    none,
    "no successful",
  ],
  [
    "no artifact",
    { fixtures: routes({ artifacts: [] }) },
    none,
    "has no blacksmith-usage artifact",
  ],
  [
    "an expired artifact",
    { fixtures: routes({ artifacts: [{ id: 9, name: "blacksmith-usage", expired: true }] }) },
    none,
    "has no blacksmith-usage artifact",
  ],
  [
    "the download fails",
    {
      fixtures: {
        ...routes(),
        "/repos/issuelt/t3code/actions/artifacts/9/zip": { status: 500 },
      },
    },
    none,
    "could not download",
  ],
  [
    "an archive without the JSON",
    { fixtures: routes({ archive: zip({ "other.json": "{}" }) }) },
    none,
    "has no blacksmith-usage.json",
  ],
  [
    "an archive with broken JSON",
    { fixtures: routes({ archive: zip({ "blacksmith-usage.json": "{" }) }) },
    none,
    "Blacksmith: none",
  ],
  [
    "the runs API fails",
    {
      fixtures: {
        ...routes(),
        "/repos/issuelt/t3code/actions/workflows/blacksmith-usage.yml/runs?branch=main&status=success&per_page=1":
          { status: 500 },
      },
    },
    none,
    "no successful",
  ],
];

for (const [name, options, expected, reason] of table) {
  test(`${name}`, () => {
    const result = route(options);
    assert.equal(result.status, 0, result.log);
    assert.deepEqual(result.outputs, expected, result.log);
    assert.match(result.log, new RegExp(reason));
  });
}

test("an untrusted event, routing off, no label, or bad kinds makes no API call", () => {
  assert.deepEqual(route({ trusted: "false" }).calls, []);
  assert.deepEqual(route({ routing: "off" }).calls, []);
  assert.deepEqual(route({ labels: {} }).calls, []);
  assert.deepEqual(route({ kinds: "linux macos" }).calls, []);
});

// Fork Release outside pull requests: route-windows decides Windows, and the
// build stage's route decides Linux and Android. Both reserve all three.
const windowsCall = (used) =>
  route({ kinds: "windows", fixtures: routes({ tally: usage({ used }) }) });
const buildCall = (used) =>
  route({ kinds: "linux android", fixtures: routes({ tally: usage({ used }) }) });

test("either Fork Release call reserves all three kinds", () => {
  for (const [call, expected] of [
    [windowsCall, { ...none, blacksmith_windows: windows }],
    [buildCall, { ...none, blacksmith_linux: linux, blacksmith_android: android }],
  ]) {
    const fits = call(360);
    assert.deepEqual(fits.outputs, expected, fits.log);
    // 361 + 600 + 240 + 720 + 480 = 2401, so Windows goes hosted while Linux and Android still fit.
    const over = call(361);
    assert.equal(over.outputs.blacksmith_linux, call === buildCall ? linux : "", over.log);
    assert.equal(over.outputs.blacksmith_android, call === buildCall ? android : "", over.log);
    assert.equal(over.outputs.blacksmith_windows, "", over.log);
  }
  // Before this change, the Windows call alone saw 361 + 600 + 480 <= 2400 and approved Windows.
  assert.equal(windowsCall(361).outputs.blacksmith_windows, "");
  assert.match(buildCall(360).log, /Blacksmith windows: reserved for another job of this run/);
});

test("a build call that reads a newer tally keeps the run within the Windows call's check", () => {
  const reservation = { [linux]: 240, [android]: 720, [windows]: 480 };
  const steps = [0, 300, 360, 361, 600, 840, 841, 1080, 1081, 1320, 1560, 1561, 1800];
  const win = Object.fromEntries(steps.map((used) => [used, windowsCall(used).outputs]));
  const build = Object.fromEntries(steps.map((used) => [used, buildCall(used).outputs]));
  for (const [i, first] of steps.entries()) {
    for (const later of steps.slice(i)) {
      const labels = [win[first].blacksmith_windows, ...Object.values(build[later])];
      const committed = labels.reduce((sum, label) => sum + (reservation[label] ?? 0), 0);
      assert.ok(committed === 0 || first + 600 + committed <= 2400, `${first} then ${later}`);
    }
  }
});

test("a Fork Release pull request reserves Linux only", () => {
  // 1561 + 600 + 240 = 2401 fails; at 1560 Linux fits, and Android and Windows reserve nothing.
  const pr = (used) =>
    route({ kinds: "linux", reserve: "linux", fixtures: routes({ tally: usage({ used }) }) });
  assert.deepEqual(pr(1560).outputs, { ...none, blacksmith_linux: linux });
  assert.doesNotMatch(pr(1560).log, /android|windows/);
  assert.deepEqual(pr(1561).outputs, none);
  // With the release list, the same tally approves Linux but no Android.
  assert.deepEqual(buildCall(1560).outputs, { ...none, blacksmith_linux: linux });
});

test("a trusted run makes three calls and keeps the token out of argv and the log", () => {
  const result = route();
  assert.equal(result.calls.length, 3);
  const seen = result.calls.join("\n") + result.log;
  assert.ok(!seen.includes(githubToken), "token leaked");
});

// The previous attempt's jobs, as /actions/runs/42/attempts/1/jobs returns them.
const jobsOf = (jobs) => ({ status: 200, body: { total_count: jobs.length, jobs } });
const waitedJob = (label, overrides = {}) => ({
  id: Math.floor(Math.random() * 1e9),
  labels: [label],
  runner_name: null,
  status: "completed",
  conclusion: "cancelled",
  ...overrides,
});
const ranJob = (label) => waitedJob(label, { runner_name: `${label}-abc`, conclusion: "success" });

test("a rerun leaves a kind hosted when its label never got a runner in the previous attempt", () => {
  const result = route({
    attempt: "2",
    fixtures: routes({
      previous: jobsOf([ranJob(linux), ranJob(android), waitedJob(windows)]),
    }),
  });
  assert.equal(result.status, 0, result.log);
  assert.deepEqual(result.outputs, {
    ...none,
    blacksmith_linux: linux,
    blacksmith_android: android,
  });
  assert.match(
    result.log,
    /Blacksmith windows: none \(blacksmith-8vcpu-windows-2025 got no runner in attempt 1\)/,
  );
  assert.equal(result.calls.length, 4);
});

test("a rerun ignores skipped jobs, hosted jobs, and labels that ran", () => {
  const result = route({
    attempt: "2",
    fixtures: routes({
      previous: jobsOf([
        waitedJob(windows, { conclusion: "skipped" }),
        waitedJob("ubuntu-24.04"),
        ranJob(linux),
      ]),
    }),
  });
  assert.deepEqual(result.outputs, all, result.log);
});

test("a rerun whose only asked label stalled makes no tally call", () => {
  const result = route({
    attempt: "2",
    kinds: "windows",
    fixtures: routes({ previous: jobsOf([waitedJob(windows)]) }),
  });
  assert.deepEqual(result.outputs, none, result.log);
  assert.match(result.log, /no label left after attempt 1/);
  assert.equal(result.calls.length, 1);
});

for (const [name, previous] of [
  ["fails", { status: 500 }],
  ["has no jobs list", { status: 200, body: { total_count: 0 } }],
  ["has more than one page", { status: 200, body: { total_count: 101, jobs: [ranJob(linux)] } }],
]) {
  test(`a rerun keeps every kind hosted when the previous attempt's jobs read ${name}`, () => {
    const result = route({ attempt: "2", fixtures: routes({ previous }) });
    assert.equal(result.status, 0, result.log);
    assert.deepEqual(result.outputs, none, result.log);
    assert.match(result.log, /could not read attempt 1's jobs/);
  });
}

test("a first attempt never reads a previous attempt", () => {
  const result = route({ fixtures: routes({ previous: jobsOf([waitedJob(windows)]) }) });
  assert.deepEqual(result.outputs, all, result.log);
  assert.ok(!result.calls.some((call) => call.includes("/attempts/")));
});

test("a label the tally saw stall in the last 6 hours stays hosted", () => {
  const result = route({
    fixtures: routes({ tally: usage({ stalled: { [windows]: iso(now - 6 * 3600) } }) }),
  });
  assert.deepEqual(result.outputs, {
    ...none,
    blacksmith_linux: linux,
    blacksmith_android: android,
  });
  assert.match(result.log, /blacksmith-8vcpu-windows-2025 stalled in the last 6 hours/);
});

test("a stall older than 6 hours, or on another label, leaves the label routed", () => {
  const result = route({
    fixtures: routes({
      tally: usage({
        stalled: { [windows]: iso(now - 6 * 3600 - 1), "blacksmith-2vcpu-ubuntu-2404": iso(now) },
      }),
    }),
  });
  assert.deepEqual(result.outputs, all, result.log);
});

test("a stalled label frees its reservation for the kinds after it", () => {
  // 1081 + 600 + 240 + 720 = 2641 leaves Android out; with Linux stalled, 1081 + 600 + 720 = 2401 still does,
  // and 1080 + 600 + 720 = 2400 fits.
  const at = (used) =>
    route({
      kinds: "linux android",
      fixtures: routes({ tally: usage({ used, stalled: { [linux]: iso(now - 60) } }) }),
    });
  assert.deepEqual(at(1080).outputs, { ...none, blacksmith_android: android });
  assert.deepEqual(at(1081).outputs, none);
});

for (const [name, stalled] of [
  ["missing", undefined],
  ["not a map", ["x"]],
  ["holding a bad time", { [linux]: "yesterday" }],
]) {
  test(`a tally whose stalled map is ${name} keeps every kind hosted`, () => {
    const tally = usage({ stalled });
    if (stalled === undefined) delete tally.stalled;
    const result = route({ fixtures: routes({ tally }) });
    assert.deepEqual(result.outputs, none, result.log);
    assert.match(result.log, /no valid stalled map/);
  });
}

test.after(() => fs.rmSync(work, { recursive: true, force: true }));
