// `watch <dir>` polls this attempt's jobs until every BLACKSMITH_LABELS job has
// a runner, or one waits 5 minutes; then it writes <dir>/blacksmith-stalled.json
// and stalled=true. `cancel` cancels the run. A failed watch exits 1 with no
// output, so missing data never cancels a run.
const fs = require("node:fs");
const path = require("node:path");

const STALL_MS = 5 * 60_000;
const POLL_MS = 20_000;
// The watched jobs share the watchdog's needs, so they exist when it starts; this covers a slow listing.
const GRACE_MS = 60_000;
// Consecutive failed polls before the watch gives up; a 4xx other than 429 gives up at once.
const MAX_FAILURES = 3;
const LABEL = /^blacksmith-[0-9]+vcpu-[a-z]+-[0-9]+$/;

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const retryable = (error) =>
  !(error instanceof ApiError) || error.status === 429 || error.status >= 500;

async function attemptJobs(request, runId, attempt) {
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const body = await request(
      "GET",
      `/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
    );
    if (!Array.isArray(body?.jobs)) throw new Error("the jobs response has no jobs list");
    jobs.push(...body.jobs);
    if (page * 100 >= (body.total_count ?? 0) || body.jobs.length === 0) return jobs;
  }
}

// Sorts one poll's jobs. A job's queue time starts at created_at, or when the watchdog first saw it.
function decide(jobs, labels, now, firstSeen, stallMs = STALL_MS) {
  const watched = jobs.filter((job) => (job.labels ?? []).some((label) => labels.includes(label)));
  const waiting = watched.filter(
    (job) => job.status === "queued" && !job.runner_name && !job.conclusion,
  );
  const stalled = waiting.filter((job) => {
    if (!firstSeen.has(job.id)) firstSeen.set(job.id, now);
    const created = Date.parse(job.created_at);
    return now - (Number.isFinite(created) ? created : firstSeen.get(job.id)) >= stallMs;
  });
  return { watched, waiting, stalled };
}

async function watch({
  request,
  runId,
  attempt,
  labels,
  clock = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
  stallMs = STALL_MS,
  pollMs = POLL_MS,
  graceMs = GRACE_MS,
}) {
  const start = clock();
  const firstSeen = new Map();
  let failures = 0;
  let seen = false;
  for (;;) {
    let jobs;
    try {
      jobs = await attemptJobs(request, runId, attempt);
      failures = 0;
    } catch (error) {
      failures += 1;
      if (!retryable(error) || failures >= MAX_FAILURES) throw error;
      log(`Poll failed (${error.message}); trying again.`);
      await sleep(pollMs);
      continue;
    }
    const now = clock();
    const { watched, waiting, stalled } = decide(jobs, labels, now, firstSeen, stallMs);
    if (stalled.length > 0) return { stalled };
    if (watched.length > 0) seen = true;
    if (waiting.length === 0 && (seen || now - start >= graceMs)) return { stalled: [], watched };
    log(`${waiting.length} Blacksmith job(s) still queued without a runner.`);
    await sleep(pollMs);
  }
}

// Writes the marker file, the step summary, and the stalled output for the next steps.
function report({ stalled, labels, runId, attempt, dir, outputFile, summaryFile }) {
  const stalledLabels = [
    ...new Set(stalled.flatMap((job) => (job.labels ?? []).filter((l) => labels.includes(l)))),
  ].sort();
  if (stalled.length === 0) {
    fs.appendFileSync(outputFile, "stalled=false\n");
    return stalledLabels;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "blacksmith-stalled.json"),
    JSON.stringify(
      {
        run_id: Number(runId),
        run_attempt: Number(attempt),
        labels: stalledLabels,
        jobs: stalled.map((job) => ({ id: job.id, name: job.name, labels: job.labels })),
      },
      null,
      2,
    ) + "\n",
  );
  const minutes = STALL_MS / 60_000;
  const names = stalled.map((job) => `\`${job.name}\``).join(", ");
  if (summaryFile) {
    fs.appendFileSync(
      summaryFile,
      `### Blacksmith job stalled\n\n${names} waited ${minutes} minutes without a runner on ` +
        `${stalledLabels.map((l) => `\`${l}\``).join(", ")}. The watchdog cancels this run, ` +
        `and blacksmith-rerun.yml reruns it with those labels on hosted runners.\n`,
    );
  }
  fs.appendFileSync(outputFile, `stalled=true\nlabels=${stalledLabels.join(" ")}\n`);
  console.log(
    `::error::${stalled.map((job) => job.name).join(", ")} waited ${minutes} minutes without a ` +
      `runner on ${stalledLabels.join(", ")}. Cancelling the run so it reruns hosted.`,
  );
  return stalledLabels;
}

async function cancel({ request, runId }) {
  await request("POST", `/actions/runs/${runId}/cancel`);
}

function parseLabels(text) {
  const labels = (text ?? "").split(/\s+/).filter(Boolean);
  const bad = labels.find((label) => !LABEL.test(label));
  if (bad !== undefined) throw new Error(`${bad} is not a Blacksmith label`);
  if (labels.length === 0) throw new Error("BLACKSMITH_LABELS is empty");
  return labels;
}

function apiRequest(env = process.env) {
  const api = env.GITHUB_API_URL || "https://api.github.com";
  return async (method, url) => {
    const response = await fetch(`${api}/repos/${env.GITHUB_REPOSITORY}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new ApiError(`${method} ${url} returned ${response.status}`, response.status);
    return method === "GET" ? response.json() : null;
  };
}

async function main() {
  const [mode, dir] = process.argv.slice(2);
  const env = process.env;
  const runId = env.GITHUB_RUN_ID;
  const attempt = env.GITHUB_RUN_ATTEMPT;
  if (!/^[0-9]+$/.test(runId ?? "") || !/^[0-9]+$/.test(attempt ?? ""))
    throw new Error("GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must be numbers");
  const request = apiRequest(env);
  if (mode === "cancel") {
    await cancel({ request, runId });
    console.log(`Cancelled run ${runId}.`);
    return;
  }
  if (mode !== "watch" || !dir)
    throw new Error("usage: blacksmith-watchdog.cjs watch <dir> | cancel");
  const labels = parseLabels(env.BLACKSMITH_LABELS);
  console.log(`Watching ${labels.join(", ")} in run ${runId} attempt ${attempt}.`);
  const { stalled } = await watch({ request, runId, attempt, labels, log: console.log });
  report({
    stalled,
    labels,
    runId,
    attempt,
    dir,
    outputFile: env.GITHUB_OUTPUT,
    summaryFile: env.GITHUB_STEP_SUMMARY,
  });
  if (stalled.length === 0) console.log("Every Blacksmith job got a runner or left the queue.");
}

module.exports = { decide, watch, report, cancel, parseLabels, apiRequest, ApiError, STALL_MS };

if (require.main === module) {
  main().catch((error) => {
    console.log(`::error::Blacksmith watchdog failed: ${error.message}`);
    process.exit(1);
  });
}
