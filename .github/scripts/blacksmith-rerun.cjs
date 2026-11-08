// Reruns a cancelled same-repository run under attempt 3 only when it has the
// watchdog's blacksmith-stalled-attempt-<n> artifact, which a person's cancel
// lacks, and no newer run of its workflow, branch, and event would share its
// concurrency group. Any failed read exits 1 without a rerun.
const fs = require("node:fs");

const REPOSITORY = "issuelt/t3code";
const MAX_ATTEMPT = 3;

// Returns { rerun, reason }. Throws when an API call fails.
async function decide({ run, repo, request }) {
  if (run?.conclusion !== "cancelled")
    return { rerun: false, reason: `the run's conclusion is ${run?.conclusion}` };
  if (repo !== REPOSITORY || run.repository?.full_name !== REPOSITORY)
    return { rerun: false, reason: `the run is not in ${REPOSITORY}` };
  if (run.head_repository?.full_name !== REPOSITORY)
    return { rerun: false, reason: `the run's head is ${run.head_repository?.full_name}` };
  if (!Number.isInteger(run.id) || !Number.isInteger(run.workflow_id))
    return { rerun: false, reason: "the event has no run or workflow id" };
  if (!Number.isInteger(run.run_attempt) || run.run_attempt >= MAX_ATTEMPT)
    return { rerun: false, reason: `attempt ${run.run_attempt} is not under ${MAX_ATTEMPT}` };

  const name = `blacksmith-stalled-attempt-${run.run_attempt}`;
  const artifacts = await request(
    "GET",
    `/actions/runs/${run.id}/artifacts?name=${encodeURIComponent(name)}`,
  );
  if (!Array.isArray(artifacts?.artifacts)) throw new Error("the artifacts response has no list");
  if (!artifacts.artifacts.some((a) => a.name === name && a.expired === false))
    return { rerun: false, reason: `the run has no ${name} artifact` };

  const newest = await request(
    "GET",
    `/actions/workflows/${run.workflow_id}/runs?branch=${encodeURIComponent(run.head_branch ?? "")}` +
      `&event=${encodeURIComponent(run.event ?? "")}&per_page=1`,
  );
  if (!Array.isArray(newest?.workflow_runs)) throw new Error("the runs response has no list");
  const latest = newest.workflow_runs[0]?.id;
  if (latest !== run.id)
    return { rerun: false, reason: `run ${latest} is newer on ${run.head_branch} (${run.event})` };

  return { rerun: true, reason: `${name} marks a stalled Blacksmith job` };
}

async function main() {
  const [eventFile] = process.argv.slice(2);
  const run = JSON.parse(fs.readFileSync(eventFile, "utf8")).workflow_run;
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const repo = process.env.GITHUB_REPOSITORY;
  const request = async (method, url) => {
    const response = await fetch(`${api}/repos/${repo}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`${method} ${url} returned ${response.status}`);
    return method === "GET" ? response.json() : null;
  };
  const { rerun, reason } = await decide({ run, repo, request });
  if (!rerun) {
    console.log(`Run ${run?.id}: no rerun (${reason}).`);
    return;
  }
  await request("POST", `/actions/runs/${run.id}/rerun`);
  console.log(`Run ${run.id}: rerun requested (${reason}).`);
}

module.exports = { decide, REPOSITORY, MAX_ATTEMPT };

if (require.main === module) {
  main().catch((error) => {
    console.log(`::error::Blacksmith rerun failed: ${error.message}`);
    process.exit(1);
  });
}
