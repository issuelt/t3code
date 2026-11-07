// Sums this UTC month's Blacksmith use by this repository in 2-vCPU x64 minutes
// for route-blacksmith.sh. It reuses the previous tally's completed runs and
// writes complete: false at MAX_CALLS or past the API's 1,000-run listing
// limit; the router refuses an incomplete tally.
const fs = require("node:fs");
const path = require("node:path");

const MAX_CALLS = 300;
const MAX_LISTED = 1000;
const LABEL = /^blacksmith-(\d+)vcpu-(ubuntu|windows|macos)-\d+(-arm(?=$|-))?(?:$|-)/;

// vCPU/2 for Ubuntu x64, times 2 for Windows, times 20 for macOS, times 0.625 for ARM.
function factor(label) {
  const match = LABEL.exec(label);
  if (!match || Number(match[1]) <= 0) return null;
  const os = { ubuntu: 1, windows: 2, macos: 20 }[match[2]];
  return (Number(match[1]) / 2) * os * (match[3] ? 0.625 : 1);
}

// Skipped jobs keep their Blacksmith label and a start time but never get a runner.
function jobUsage(job, now) {
  if (!job.runner_name || !job.started_at) return 0;
  const blacksmith =
    job.runner_name.startsWith("blacksmith") ||
    (job.labels ?? []).some((label) => label.startsWith("blacksmith-"));
  if (!blacksmith) return 0;
  const label = (job.labels ?? []).find((l) => l.startsWith("blacksmith-")) ?? job.runner_name;
  const f = factor(label);
  if (f === null) throw new Error(`job ${job.id} ran on ${label}, which has no known factor`);
  const end = job.completed_at ? Date.parse(job.completed_at) : now;
  const seconds = Math.max(0, (end - Date.parse(job.started_at)) / 1000);
  return Math.max(1, Math.ceil(seconds / 60)) * f;
}

function monthOf(now) {
  return new Date(now).toISOString().slice(0, 7);
}

function previousMonthStart(month) {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number - 2, 1)).toISOString().replace(/\.\d+Z$/, "Z");
}

// A workflow can use Blacksmith if its file names it or calls a file that does.
// This tally names Blacksmith too but always runs hosted.
function candidateFiles(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f) && f !== "blacksmith-usage.yml");
  const text = Object.fromEntries(
    files.map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]),
  );
  const found = new Set(files.filter((f) => /blacksmith/i.test(text[f])));
  for (let grew = true; grew;) {
    grew = false;
    for (const f of files) {
      if (found.has(f)) continue;
      const calls = (g) =>
        text[f].includes(`/.github/workflows/${g}@`) ||
        text[f].includes(`./.github/workflows/${g}`);
      if ([...found].some(calls)) {
        found.add(f);
        grew = true;
      }
    }
  }
  return [...found].sort().map((f) => `.github/workflows/${f}`);
}

async function tally({ request, files, previous, now, maxCalls = MAX_CALLS }) {
  const month = monthOf(now);
  const sameMonth = previous?.month === month;
  const cached = sameMonth ? (previous.runs ?? {}) : {};
  const spent = sameMonth ? (previous.workflows ?? {}) : {};
  let calls = 0;
  const get = async (url) => {
    if (calls >= maxCalls) throw Object.assign(new Error("call budget spent"), { budget: true });
    calls += 1;
    return request(url);
  };

  const runs = {};
  const workflows = {};
  let used = 0;
  let complete = true;
  try {
    const listed = await get("/actions/workflows?per_page=100");
    if ((listed.total_count ?? 0) > 100) throw new Error("more than 100 workflows");
    // Any state: a disabled or deleted workflow, or one that no longer names Blacksmith, already spent this month.
    const counted = listed.workflows.filter((w) => files.includes(w.path) || spent[w.path] > 0);
    // A run created last month can be re-run this month, and its jobs count by start time.
    const since = previousMonthStart(month);
    for (const workflow of counted) {
      workflows[workflow.path] = 0;
      for (let page = 1; ; page += 1) {
        const body = await get(
          `/actions/workflows/${workflow.id}/runs?created=${encodeURIComponent(`>=${since}`)}&exclude_pull_requests=true&per_page=100&page=${page}`,
        );
        if ((body.total_count ?? 0) > MAX_LISTED) complete = false;
        for (const run of body.workflow_runs) {
          const key = String(run.id);
          const hit = cached[key];
          let total;
          if (run.status === "completed" && hit && hit.attempt === run.run_attempt) {
            total = hit.used;
          } else {
            total = 0;
            for (let jobPage = 1; ; jobPage += 1) {
              const jobs = await get(
                `/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${jobPage}`,
              );
              for (const job of jobs.jobs) {
                if (job.started_at && monthOf(Date.parse(job.started_at)) === month)
                  total += jobUsage(job, now);
              }
              if (jobPage * 100 >= (jobs.total_count ?? 0)) break;
            }
          }
          if (run.status === "completed") runs[key] = { attempt: run.run_attempt, used: total };
          workflows[workflow.path] += total;
          used += total;
        }
        if (page * 100 >= Math.min(body.total_count ?? 0, MAX_LISTED)) break;
      }
    }
    // A workflow the API no longer lists keeps the usage the previous tally recorded.
    for (const [file, total] of Object.entries(spent)) {
      if (file in workflows || !(total > 0)) continue;
      workflows[file] = total;
      used += total;
    }
  } catch (error) {
    if (!error.budget) throw error;
    complete = false;
  }
  return {
    month,
    used: Math.ceil(used),
    complete,
    computed_at: new Date(now).toISOString().replace(/\.\d+Z$/, "Z"),
    calls,
    workflows,
    runs: complete ? runs : { ...cached, ...runs },
  };
}

async function main() {
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const repo = process.env.GITHUB_REPOSITORY;
  const [workflowDir, previousFile, outFile] = process.argv.slice(2);
  const request = async (url) => {
    const response = await fetch(`${api}/repos/${repo}${url}`, {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
    return response.json();
  };
  let previous = null;
  if (previousFile && fs.existsSync(previousFile))
    previous = JSON.parse(fs.readFileSync(previousFile, "utf8"));
  const files = candidateFiles(workflowDir);
  const result = await tally({ request, files, previous, now: Date.now() });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
  console.log(`Workflows counted: ${files.join(", ")}`);
  console.log(
    `Blacksmith ${result.month}: ${result.used} 2-vCPU minutes, ${result.calls} calls, complete: ${result.complete}.`,
  );
  for (const [file, total] of Object.entries(result.workflows)) console.log(`  ${file}: ${total}`);
}

module.exports = { factor, jobUsage, candidateFiles, tally, MAX_CALLS };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
