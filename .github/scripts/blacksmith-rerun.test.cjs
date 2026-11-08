const assert = require("node:assert/strict");
const test = require("node:test");

const { decide } = require("./blacksmith-rerun.cjs");

const repo = "issuelt/t3code";
const marker = (attempt, overrides = {}) => ({
  name: `blacksmith-stalled-attempt-${attempt}`,
  expired: false,
  ...overrides,
});

// A workflow_run payload for a run the watchdog cancelled in its first attempt.
const run = (overrides = {}) => ({
  id: 100,
  workflow_id: 7,
  conclusion: "cancelled",
  run_attempt: 1,
  head_branch: "main",
  event: "push",
  repository: { full_name: repo },
  head_repository: { full_name: repo },
  ...overrides,
});

function fake({ artifacts = [marker(1)], newest = 100, fail } = {}) {
  const calls = [];
  const request = async (method, url) => {
    calls.push(`${method} ${url}`);
    if (fail && url.includes(fail)) throw new Error(`${method} ${url} returned 500`);
    if (url.startsWith("/actions/runs/100/artifacts?")) return { artifacts };
    if (url.startsWith("/actions/workflows/7/runs?"))
      return { workflow_runs: newest === null ? [] : [{ id: newest }] };
    throw new Error(`${method} ${url} returned 404`);
  };
  return { request, calls };
}

test("a watchdog cancel in attempt 1 or 2 is rerun", async () => {
  for (const attempt of [1, 2]) {
    const api = fake({ artifacts: [marker(attempt)] });
    const result = await decide({ run: run({ run_attempt: attempt }), repo, request: api.request });
    assert.equal(result.rerun, true, result.reason);
    assert.deepEqual(api.calls, [
      `GET /actions/runs/100/artifacts?name=blacksmith-stalled-attempt-${attempt}`,
      "GET /actions/workflows/7/runs?branch=main&event=push&per_page=1",
    ]);
  }
});

const refused = [
  ["a run that succeeded", { run: run({ conclusion: "success" }) }, /conclusion is success/],
  ["a run that failed", { run: run({ conclusion: "failure" }) }, /conclusion is failure/],
  ["a run in another repository", { repo: "someone/t3code" }, /not in issuelt\/t3code/],
  [
    "a run whose repository field is another one",
    { run: run({ repository: { full_name: "someone/t3code" } }) },
    /not in issuelt\/t3code/,
  ],
  [
    "a fork pull request",
    { run: run({ head_repository: { full_name: "someone/t3code" }, event: "pull_request" }) },
    /head is someone\/t3code/,
  ],
  ["a third attempt", { run: run({ run_attempt: 3 }) }, /attempt 3 is not under 3/],
  ["a missing attempt", { run: run({ run_attempt: undefined }) }, /not under 3/],
  [
    "a person's cancel, with no marker",
    { api: fake({ artifacts: [] }) },
    /no blacksmith-stalled-attempt-1 artifact/,
  ],
  [
    "a marker from another attempt",
    { run: run({ run_attempt: 2 }), api: fake({ artifacts: [marker(1)] }) },
    /no blacksmith-stalled-attempt-2 artifact/,
  ],
  [
    "an expired marker",
    { api: fake({ artifacts: [marker(1, { expired: true })] }) },
    /no blacksmith-stalled-attempt-1 artifact/,
  ],
  ["a newer run on the same branch", { api: fake({ newest: 101 }) }, /run 101 is newer/],
];

for (const [name, options, reason] of refused) {
  test(`no rerun for ${name}`, async () => {
    const api = options.api ?? fake();
    const result = await decide({
      run: options.run ?? run(),
      repo: options.repo ?? repo,
      request: api.request,
    });
    assert.equal(result.rerun, false);
    assert.match(result.reason, reason);
    assert.ok(api.calls.every((call) => call.startsWith("GET ")));
  });
}

test("checks that need no API call make none", async () => {
  for (const options of [
    { run: run({ conclusion: "success" }) },
    { run: run({ head_repository: { full_name: "someone/t3code" } }) },
    { run: run({ run_attempt: 3 }) },
  ]) {
    const api = fake();
    await decide({ run: options.run, repo, request: api.request });
    assert.deepEqual(api.calls, []);
  }
});

test("a failed artifact or runs read throws, so no rerun is posted", async () => {
  await assert.rejects(
    decide({ run: run(), repo, request: fake({ fail: "/artifacts" }).request }),
    /500/,
  );
  await assert.rejects(
    decide({ run: run(), repo, request: fake({ fail: "/workflows/" }).request }),
    /500/,
  );
  const broken = async () => ({});
  await assert.rejects(decide({ run: run(), repo, request: broken }), /no list/);
});
