// Reruns a cancelled same-repository run under attempt 3 only when it has the
// watchdog's blacksmith-stalled-attempt-<n>-<job> artifact, which a person's
// cancel lacks, and no newer run of its workflow is in its concurrency group.
// Any failed read exits 1 without a rerun.
const fs = require("node:fs");

const REPOSITORY = "issuelt/t3code";
const MAX_ATTEMPT = 3;

// The concurrency groups in fork-ci.yml and fork-release.yml. Both key a pull
// request by its number; head repository and branch identify it here. Fork CI
// otherwise has one group per SHA, and Fork Release one group for all other runs.
function concurrencyGroup(run) {
  const workflow = {
    ".github/workflows/fork-ci.yml": "ci",
    ".github/workflows/fork-release.yml": "release",
  }[run.path];
  if (!workflow) return null;
  if (run.event === "pull_request")
    return `${workflow}-pr-${run.head_repository?.full_name}-${run.head_branch}`;
  return workflow === "ci" ? `ci-${run.head_sha}` : "release-main";
}

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
  const group = concurrencyGroup(run);
  if (!group) return { rerun: false, reason: `no concurrency group is known for ${run.path}` };

  const prefix = `blacksmith-stalled-attempt-${run.run_attempt}-`;
  const artifacts = await request("GET", `/actions/runs/${run.id}/artifacts?per_page=100`);
  if (!Array.isArray(artifacts?.artifacts)) throw new Error("the artifacts response has no list");
  const marker = artifacts.artifacts.find((a) => a.name?.startsWith(prefix) && a.expired === false);
  if (!marker) return { rerun: false, reason: `the run has no ${prefix}* artifact` };

  const newest = await request("GET", `/actions/workflows/${run.workflow_id}/runs?per_page=100`);
  const listed = newest?.workflow_runs;
  if (!Array.isArray(listed)) throw new Error("the runs response has no list");
  // Runs come newest first. Without this run on the page, a newer run could be on a later one.
  if (!listed.some((candidate) => candidate.id === run.id))
    return { rerun: false, reason: `run ${run.id} is not among the newest ${listed.length} runs` };
  const newer = listed.find((c) => c.id > run.id && concurrencyGroup(c) === group);
  if (newer) return { rerun: false, reason: `run ${newer.id} is newer in group ${group}` };

  return { rerun: true, reason: `${marker.name} marks a stalled Blacksmith job` };
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

module.exports = { decide, concurrencyGroup, REPOSITORY, MAX_ATTEMPT };

if (require.main === module) {
  main().catch((error) => {
    console.log(`::error::Blacksmith rerun failed: ${error.message}`);
    process.exit(1);
  });
}
