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
  ...overrides,
});

const routes = ({
  tally = usage(),
  run = { id: 7, head_branch: "main", event: "schedule" },
  artifacts = [{ id: 9, name: "blacksmith-usage", expired: false }],
  archive,
} = {}) => ({
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
  token = githubToken,
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
      BLACKSMITH_LINUX_LABEL: labels.linux ?? "",
      BLACKSMITH_ANDROID_LABEL: labels.android ?? "",
      BLACKSMITH_WINDOWS_LABEL: labels.windows ?? "",
      GH_TOKEN: token,
      GITHUB_API_URL: api,
      GITHUB_REPOSITORY: "issuelt/t3code",
      GITHUB_OUTPUT: output,
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

// Reservations: linux 8 vCPU is 60 * 4 = 240, android 16 vCPU is 60 * 8 = 480,
// windows 8 vCPU is 60 * 4 * 2 = 480. Each fits while used + 600 + reservation <= 2400.
const table = [
  ["nothing used", {}, all, "used 0 of 2400"],
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
    "one more hour of blacksmith-8vcpu-ubuntu-2404 would pass",
  ],
  [
    "the larger reservations exactly at the budget",
    { fixtures: routes({ tally: usage({ used: 1320 }) }) },
    all,
    "used 1320",
  ],
  [
    "the larger reservations one minute over",
    { fixtures: routes({ tally: usage({ used: 1321 }) }) },
    { ...none, blacksmith_linux: linux },
    "one more hour of blacksmith-16vcpu-ubuntu-2404 would pass",
  ],
  ["untrusted event, such as a fork pull request", { trusted: "false" }, none, "untrusted event"],
  ["BLACKSMITH_ROUTING=off", { routing: "off" }, none, "BLACKSMITH_ROUTING is off"],
  ["BLACKSMITH_ROUTING=on", { routing: "on" }, all, "used 0"],
  ["no labels", { labels: {} }, none, "no valid label"],
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
    "a label that tries to inject JSON",
    { labels: { linux: 'blacksmith-8vcpu-ubuntu-2404","x' } },
    none,
    "no valid label",
  ],
  ["a hosted label", { labels: { linux: "ubuntu-24.04" } }, none, "not a supported label"],
  ["a 0 vCPU label", { labels: { linux: "blacksmith-0vcpu-ubuntu-2404" } }, none, "would pass"],
  ["no GITHUB_TOKEN", { token: "" }, none, "no GITHUB_TOKEN"],
  [
    "a tally 3 hours and 1 second old",
    { fixtures: routes({ tally: usage({ computed_at: iso(now - 3 * 3600 - 1) }) }) },
    none,
    "is stale",
  ],
  [
    "a tally exactly 3 hours old",
    { fixtures: routes({ tally: usage({ computed_at: iso(now - 3 * 3600) }) }) },
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
    { fixtures: routes({ run: { id: 7, head_branch: "pr", event: "workflow_dispatch" } }) },
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

test("an untrusted event, routing off, or no label makes no API call", () => {
  assert.deepEqual(route({ trusted: "false" }).calls, []);
  assert.deepEqual(route({ routing: "off" }).calls, []);
  assert.deepEqual(route({ labels: {} }).calls, []);
});

test("a trusted run makes three calls and keeps the token out of argv and the log", () => {
  const result = route();
  assert.equal(result.calls.length, 3);
  const seen = result.calls.join("\n") + result.log;
  assert.ok(!seen.includes(githubToken), "token leaked");
});

test.after(() => fs.rmSync(work, { recursive: true, force: true }));
