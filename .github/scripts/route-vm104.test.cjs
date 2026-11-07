const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const script = path.join(__dirname, "route-vm104.sh");
const label = "issuelt-t3code-ubuntu24";
const api = "https://api.test";
const installationToken = "ghs_router_installation_token";
const githubToken = "ghs_workflow_token";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "route-vm104-"));
const keyFile = path.join(work, "key.pem");
execFileSync(
  "openssl",
  ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", keyFile],
  {
    stdio: "ignore",
  },
);
const appKey = fs.readFileSync(keyFile, "utf8");

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
process.stdout.write(JSON.stringify(fixture.body));
`,
  { mode: 0o755 },
);

const runner = (overrides = {}) => ({
  name: "ci-ubuntu104-1",
  status: "online",
  busy: false,
  labels: [{ name: "self-hosted" }, { name: "Linux" }, { name: label }],
  ...overrides,
});

const routes = ({ runners = [runner()], queuedJobs = [], runningJobs = [], mint = 201 } = {}) => ({
  "/app/installations/179653734/access_tokens": {
    status: mint,
    body: { token: installationToken },
  },
  "/orgs/issuelt/actions/runner-groups/10/runners?per_page=100": { status: 200, body: { runners } },
  "/repos/issuelt/t3code/actions/runs?status=queued&per_page=100": {
    status: 200,
    body: { workflow_runs: [{ id: 1 }] },
  },
  "/repos/issuelt/t3code/actions/runs?status=in_progress&per_page=100": {
    status: 200,
    body: { workflow_runs: [{ id: 2 }] },
  },
  "/repos/issuelt/t3code/actions/runs/1/jobs?filter=latest&per_page=100": {
    status: 200,
    body: { jobs: queuedJobs },
  },
  "/repos/issuelt/t3code/actions/runs/2/jobs?filter=latest&per_page=100": {
    status: 200,
    body: { jobs: runningJobs },
  },
});

function route({
  fixtures = routes(),
  trusted = "true",
  appId = "123456",
  key = appKey,
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
      APP_ID: appId,
      APP_KEY: key,
      GH_TOKEN: token,
      GITHUB_API_URL: api,
      GITHUB_REPOSITORY: "issuelt/t3code",
      GITHUB_OUTPUT: output,
      ROUTE_FIXTURES: JSON.stringify(fixtures),
      ROUTE_CALLS: calls,
    },
  });
  return {
    status: result.status,
    log: result.stdout + result.stderr,
    output: fs.readFileSync(output, "utf8"),
    calls: fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
  };
}

const busyJob = { status: "queued", labels: [label] };

const table = [
  ["idle runner, nothing queued", {}, true, "idle runner"],
  ["untrusted event, such as a fork pull request", { trusted: "false" }, false, "untrusted event"],
  ["no App id, as in a run without the variable", { appId: "" }, false, "no router App credential"],
  ["no App key, as in a fork pull request", { key: "" }, false, "no router App credential"],
  ["no GITHUB_TOKEN", { token: "" }, false, "no GITHUB_TOKEN"],
  ["key that openssl cannot read", { key: "not a key" }, false, "could not sign"],
  ["token mint fails", { fixtures: routes({ mint: 401 }) }, false, "could not mint"],
  [
    "runner busy",
    { fixtures: routes({ runners: [runner({ busy: true })] }) },
    false,
    "no online idle runner",
  ],
  [
    "runner offline",
    { fixtures: routes({ runners: [runner({ status: "offline" })] }) },
    false,
    "no online idle runner",
  ],
  ["no runner in the group", { fixtures: routes({ runners: [] }) }, false, "no online idle runner"],
  [
    "idle runner without the label",
    { fixtures: routes({ runners: [runner({ labels: [{ name: "self-hosted" }] })] }) },
    false,
    "no online idle runner",
  ],
  [
    "job queued for the label in a queued run",
    { fixtures: routes({ queuedJobs: [busyJob] }) },
    false,
    "run 1 has a job queued",
  ],
  [
    "job queued for the label in a running run",
    { fixtures: routes({ runningJobs: [busyJob] }) },
    false,
    "run 2 has a job queued",
  ],
  [
    "queued job for another label",
    { fixtures: routes({ queuedJobs: [{ status: "queued", labels: ["ubuntu-24.04"] }] }) },
    true,
    "idle runner",
  ],
  [
    "running job on the label",
    { fixtures: routes({ runningJobs: [{ status: "in_progress", labels: [label] }] }) },
    true,
    "idle runner",
  ],
  [
    "runner group API fails",
    {
      fixtures: {
        ...routes(),
        "/orgs/issuelt/actions/runner-groups/10/runners?per_page=100": { status: 500 },
      },
    },
    false,
    "could not read runner group",
  ],
  [
    "runs API fails",
    {
      fixtures: {
        ...routes(),
        "/repos/issuelt/t3code/actions/runs?status=in_progress&per_page=100": { status: 500 },
      },
    },
    false,
    "could not list in_progress runs",
  ],
  [
    "jobs API fails",
    {
      fixtures: {
        ...routes(),
        "/repos/issuelt/t3code/actions/runs/1/jobs?filter=latest&per_page=100": { status: 500 },
      },
    },
    false,
    "could not list the jobs of run 1",
  ],
  [
    "more than one page of runners",
    {
      fixtures: {
        ...routes(),
        "/orgs/issuelt/actions/runner-groups/10/runners?per_page=100": {
          status: 200,
          body: { total_count: 101, runners: [runner()] },
        },
      },
    },
    false,
    "could not read runner group",
  ],
  [
    "more than one page of queued runs",
    {
      fixtures: {
        ...routes(),
        "/repos/issuelt/t3code/actions/runs?status=queued&per_page=100": {
          status: 200,
          body: { total_count: 101, workflow_runs: [{ id: 1 }] },
        },
      },
    },
    false,
    "could not list queued runs",
  ],
  [
    "more than 10 active runs",
    {
      fixtures: (() => {
        const f = routes();
        const ids = Array.from({ length: 11 }, (_, i) => 100 + i);
        f["/repos/issuelt/t3code/actions/runs?status=queued&per_page=100"] = {
          status: 200,
          body: { workflow_runs: ids.map((id) => ({ id })) },
        };
        for (const id of ids) {
          f[`/repos/issuelt/t3code/actions/runs/${id}/jobs?filter=latest&per_page=100`] = {
            status: 200,
            body: { jobs: [] },
          };
        }
        return f;
      })(),
    },
    false,
    "more than 10 active runs",
  ],
  [
    "runner group answer is not JSON-shaped",
    {
      fixtures: {
        ...routes(),
        "/orgs/issuelt/actions/runner-groups/10/runners?per_page=100": { status: 200, body: {} },
      },
    },
    false,
    "could not read runner group",
  ],
];

for (const [name, options, vm104, reason] of table) {
  test(`${name} routes to ${vm104 ? "VM104" : "ubuntu-24.04"}`, () => {
    const result = route(options);
    assert.equal(result.status, 0, result.log);
    assert.equal(result.output, `vm104=${vm104}\n`);
    assert.match(result.log, new RegExp(reason));
  });
}

test("an untrusted event makes no API call", () => {
  assert.deepEqual(route({ trusted: "false" }).calls, []);
});

test("no token or key reaches argv or the log", () => {
  const result = route();
  const seen = result.calls.join("\n") + result.log;
  for (const secret of [installationToken, githubToken, "PRIVATE KEY"]) {
    assert.ok(!seen.includes(secret), `${secret} leaked`);
  }
});

test.after(() => fs.rmSync(work, { recursive: true, force: true }));
