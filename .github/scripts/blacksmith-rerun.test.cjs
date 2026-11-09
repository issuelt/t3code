const assert = require("node:assert/strict");
const test = require("node:test");

const { decide, concurrencyGroup } = require("./blacksmith-rerun.cjs");

const repo = "issuelt/t3code";
const marker = (attempt, job = "check", overrides = {}) => ({
  name: `blacksmith-stalled-attempt-${attempt}-${job}`,
  expired: false,
  ...overrides,
});

const ci = ".github/workflows/fork-ci.yml";
const release = ".github/workflows/fork-release.yml";

// A workflow_run payload for a Fork CI push run the watchdog cancelled in its first attempt.
const run = (overrides = {}) => ({
  id: 100,
  workflow_id: 7,
  path: ci,
  conclusion: "cancelled",
  run_attempt: 1,
  head_branch: "main",
  head_sha: "aaa",
  event: "push",
  repository: { full_name: repo },
  head_repository: { full_name: repo },
  ...overrides,
});

function fake({ artifacts = [marker(1)], runs, target = run(), fail } = {}) {
  const calls = [];
  const listed = runs ?? [target];
  const request = async (method, url) => {
    calls.push(`${method} ${url}`);
    if (fail && url.includes(fail)) throw new Error(`${method} ${url} returned 500`);
    if (url === "/actions/runs/100/artifacts?per_page=100") return { artifacts };
    if (url === "/actions/workflows/7/runs?per_page=100") return { workflow_runs: listed };
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
      "GET /actions/runs/100/artifacts?per_page=100",
      "GET /actions/workflows/7/runs?per_page=100",
    ]);
  }
});

test("any watchdog's marker is enough", async () => {
  for (const job of ["check", "linux", "windows"]) {
    const api = fake({ artifacts: [marker(1, job)] });
    const result = await decide({ run: run(), repo, request: api.request });
    assert.equal(result.rerun, true, result.reason);
  }
});

test("the groups match the workflows' concurrency keys", () => {
  const pr = { event: "pull_request", head_branch: "fix" };
  assert.equal(concurrencyGroup(run({ head_sha: "bbb" })), "ci-bbb");
  assert.equal(concurrencyGroup(run(pr)), `ci-pr-${repo}-fix`);
  assert.equal(concurrencyGroup(run({ path: release })), "release-main");
  assert.equal(
    concurrencyGroup(run({ path: release, event: "workflow_dispatch" })),
    "release-main",
  );
  assert.equal(concurrencyGroup(run({ path: release, ...pr })), `release-pr-${repo}-fix`);
  assert.equal(concurrencyGroup(run({ path: ".github/workflows/other.yml" })), null);
});

const reruns = [
  [
    "a Fork CI push run when a newer push has its own SHA's group",
    run(),
    [run({ id: 101, head_sha: "bbb" }), run()],
  ],
  [
    "a Fork CI pull request when a newer run belongs to another pull request",
    run({ event: "pull_request", head_branch: "fix", head_sha: "ccc" }),
    [
      run({ id: 101, event: "pull_request", head_branch: "other", head_sha: "ddd" }),
      run({ event: "pull_request", head_branch: "fix", head_sha: "ccc" }),
    ],
  ],
  [
    "a Fork Release push when the newer run is a pull request's",
    run({ path: release }),
    [
      run({ id: 101, path: release, event: "pull_request", head_branch: "fix" }),
      run({ path: release }),
    ],
  ],
];

for (const [name, target, runs] of reruns) {
  test(`rerun for ${name}`, async () => {
    const result = await decide({ run: target, repo, request: fake({ runs }).request });
    assert.equal(result.rerun, true, result.reason);
  });
}

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
    "a workflow with no known group",
    { run: run({ path: ".github/workflows/other.yml" }) },
    /no concurrency group is known/,
  ],
  [
    "a person's cancel, with no marker",
    { api: fake({ artifacts: [] }) },
    /no blacksmith-stalled-attempt-1-\* artifact/,
  ],
  [
    "a marker from another attempt",
    { run: run({ run_attempt: 2 }), api: fake({ artifacts: [marker(1)] }) },
    /no blacksmith-stalled-attempt-2-\* artifact/,
  ],
  [
    "a marker from attempt 11 on attempt 1",
    { api: fake({ artifacts: [marker(11)] }) },
    /no blacksmith-stalled-attempt-1-\* artifact/,
  ],
  [
    "an expired marker",
    { api: fake({ artifacts: [marker(1, "check", { expired: true })] }) },
    /no blacksmith-stalled-attempt-1-\* artifact/,
  ],
  [
    "a newer Fork CI run of the same SHA",
    { api: fake({ runs: [run({ id: 101 }), run()] }) },
    /run 101 is newer in group ci-aaa/,
  ],
  [
    "a newer run of the same pull request",
    (() => {
      const target = run({ event: "pull_request", head_branch: "fix" });
      return {
        run: target,
        api: fake({
          runs: [
            run({ id: 101, event: "pull_request", head_branch: "fix", head_sha: "ddd" }),
            target,
          ],
        }),
      };
    })(),
    /run 101 is newer in group ci-pr-/,
  ],
  [
    "a Fork Release push with a newer manual run",
    (() => {
      const target = run({ path: release });
      return {
        run: target,
        api: fake({ runs: [run({ id: 101, path: release, event: "workflow_dispatch" }), target] }),
      };
    })(),
    /run 101 is newer in group release-main/,
  ],
  [
    "a run missing from the first page of runs",
    { api: fake({ runs: [run({ id: 101, head_sha: "bbb" })] }) },
    /run 100 is not among the newest 1 runs/,
  ],
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
    { run: run({ path: ".github/workflows/other.yml" }) },
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
