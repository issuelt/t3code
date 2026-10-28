import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type EnvironmentId,
  type ProjectId,
  type ProjectCiResult,
} from "@t3tools/contracts";
import { request } from "@t3tools/client-runtime/rpc";
import { useState } from "react";
import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useProjects } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { useDeadlinePassed } from "~/hooks/useDeadline";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import {
  createProjectCiRows,
  createProjectCiRunView,
  limitProjectCiReads,
  type Target,
  type RunTarget,
} from "./projectCiState";
import { Button } from "~/components/ui/button";
import { SidebarInset } from "~/components/ui/sidebar";

const ciQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web:project-ci",
  tag: WS_METHODS.projectCiRead,
  staleTimeMs: 60_000,
  execute: (input) => limitProjectCiReads(request(WS_METHODS.projectCiRead, input)),
});
const runQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web:project-ci-run",
  tag: WS_METHODS.projectCiReadRun,
  staleTimeMs: 60_000,
  execute: (input) => limitProjectCiReads(request(WS_METHODS.projectCiReadRun, input)),
});
const runView = createProjectCiRunView(runQuery);

type Run = ProjectCiResult["runs"][number];
type Filter = "all" | "active" | "failed" | "passed";
function category(run: Run): Exclude<Filter, "all"> | "other" {
  if (
    [
      "queued",
      "pending",
      "waiting",
      "requested",
      "in_progress",
      "running",
      "preparing",
      "created",
      "waiting_for_resource",
    ].includes(run.status.toLowerCase())
  )
    return "active";
  if (
    ["failure", "failed", "timed_out", "cancelled", "action_required"].includes(
      (run.conclusion ?? run.status).toLowerCase(),
    )
  )
    return "failed";
  if (["success", "passed"].includes((run.conclusion ?? run.status).toLowerCase())) return "passed";
  return "other";
}
export function orderRuns<T extends { run: Run }>(runs: readonly T[], filter: Filter): T[] {
  return runs
    .filter(({ run }) => filter === "all" || category(run) === filter)
    .toSorted(
      (a, b) =>
        Number(category(b.run) === "active") - Number(category(a.run) === "active") ||
        b.run.createdAt.localeCompare(a.run.createdAt),
    );
}
const aggregate = createProjectCiRows(ciQuery);

export function ProjectCiContent() {
  const projects = useProjects().filter((project) => !project.isScratch);
  const { environments } = useEnvironments();
  const [remotes, setRemotes] = useState<Record<string, string>>({});
  const [providers, setProviders] = useState<Record<string, "github" | "gitlab" | "">>({});
  const [filter, setFilter] = useState<Filter>("all");
  const keyFor = (environmentId: EnvironmentId, projectId: ProjectId) =>
    JSON.stringify([environmentId, projectId]);
  const targets = projects.map((project): Target => {
    const key = keyFor(project.environmentId, project.id);
    const remoteName = remotes[key];
    const provider = providers[key];
    return {
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        ...(remoteName ? { remoteName } : {}),
        ...(provider ? { provider } : {}),
      },
    };
  });
  const rows = useAtomValue(aggregate(targets));
  const refreshRow = (row: (typeof rows)[number]) => {
    if (row.pending) return;
    appAtomRegistry.refresh(ciQuery(row.discoveryTarget));
    if (row.runTarget) appAtomRegistry.refresh(ciQuery(row.runTarget));
  };
  useLiveRefresh(() => rows.forEach(refreshRow), {
    key: "project-ci",
    intervalMs: 60_000,
  });
  const runs = orderRuns(
    rows.flatMap((row) => (row.data?.runs ?? []).map((run) => ({ row, run }))),
    filter,
  );
  return (
    <div className="h-full overflow-auto scrollbar-gutter-both">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-5 py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">CI runs</h1>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          Status
          <select
            className="rounded border bg-background p-2"
            value={filter}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "all" || value === "active" || value === "failed" || value === "passed")
                setFilter(value);
            }}
          >
            <option value="all">All</option>
            <option value="active">Running or queued</option>
            <option value="failed">Failed</option>
            <option value="passed">Passed</option>
          </select>
        </label>
        {projects.length === 0 && (
          <p className="text-sm text-muted-foreground">No registered projects.</p>
        )}
        <div className="flex flex-col gap-2">
          {rows.map((row) => {
            const key = keyFor(row.target.environmentId, row.target.input.projectId);
            const project = projects.find(
              (item) =>
                item.environmentId === row.target.environmentId &&
                item.id === row.target.input.projectId,
            );
            const environment = environments.find(
              (item) => item.environmentId === row.target.environmentId,
            );
            return (
              <div key={key} className="rounded border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {project?.title} · {environment?.label ?? row.target.environmentId}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={row.pending}
                    onClick={() => refreshRow(row)}
                  >
                    Refresh
                  </Button>
                </div>
                <label className="mt-2 flex flex-wrap items-center gap-2">
                  Remote{" "}
                  <select
                    className="rounded border bg-background p-1"
                    value={remotes[key] ?? ""}
                    onChange={(event) =>
                      setRemotes((previous) => ({ ...previous, [key]: event.target.value }))
                    }
                  >
                    <option value="">
                      {row.selectedRemote && !remotes[key]
                        ? `Automatic · ${row.selectedRemote.name} (${row.selectedRemote.host})`
                        : "Automatic remote"}
                    </option>
                    {remotes[key] &&
                      !row.discovery?.remotes.some((remote) => remote.name === remotes[key]) && (
                        <option value={remotes[key]}>{remotes[key]}</option>
                      )}
                    {(row.discovery?.remotes ?? []).map((remote) => (
                      <option key={remote.name} value={remote.name}>
                        {remote.name} · {remote.repository} ({remote.host})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="mt-2 flex flex-wrap items-center gap-2">
                  Provider{" "}
                  <select
                    className="rounded border bg-background p-1"
                    value={providers[key] ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === "" || value === "github" || value === "gitlab")
                        setProviders((previous) => ({ ...previous, [key]: value }));
                    }}
                  >
                    <option value="">Auto-detect</option>
                    <option value="github">GitHub</option>
                    <option value="gitlab">GitLab</option>
                  </select>
                </label>
                {row.selectedRemote && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {row.selectedRemote.name} · {row.selectedRemote.repository} (
                    {row.selectedRemote.host})
                  </p>
                )}
                <PipelineFreshness
                  fetchedAt={row.data?.fetchedAt ?? null}
                  failed={row.error !== null}
                />
                {row.data?.activeRunsIncomplete && (
                  <p role="status" className="text-sm text-muted-foreground">
                    Some active runs could not be checked. Recent and successfully checked runs are
                    shown. Refresh to retry.
                  </p>
                )}
                {row.data?.activeRunsTruncated && (
                  <p role="status" className="text-sm text-muted-foreground">
                    Active run limit reached. More runs may be available on the provider.
                  </p>
                )}
                {row.pending && <p>Loading CI runs...</p>}
                {row.error && (
                  <p role="alert" className="text-destructive">
                    {row.error}
                  </p>
                )}
              </div>
            );
          })}
        </div>
        {!rows.some((row) => row.pending || row.error) && runs.length === 0 && (
          <p className="text-sm text-muted-foreground">No CI runs match this filter.</p>
        )}
        <div className="flex flex-col gap-2">
          {runs.map(({ row, run }) =>
            row.runTarget?.input.remoteName ? (
              <CiRunRow
                key={JSON.stringify([
                  row.target.environmentId,
                  row.target.input,
                  row.runTarget.input,
                  run.id,
                ])}
                target={{
                  ...row.runTarget,
                  input: {
                    ...row.runTarget.input,
                    remoteName: row.runTarget.input.remoteName,
                    runId: run.id,
                  },
                }}
                run={run}
                projectTitle={
                  projects.find(
                    (project) =>
                      project.environmentId === row.target.environmentId &&
                      project.id === row.target.input.projectId,
                  )?.title ?? "Project"
                }
                repository={row.data?.selectedRemote?.repository ?? ""}
              />
            ) : null,
          )}
        </div>
      </div>
    </div>
  );
}
function PipelineFreshness({ fetchedAt, failed }: { fetchedAt: string | null; failed: boolean }) {
  const expired = useDeadlinePassed(fetchedAt === null ? null : Date.parse(fetchedAt) + 60_000);
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      {fetchedAt === null
        ? "Pipelines have not been fetched."
        : `Pipelines fetched ${new Date(fetchedAt).toLocaleString()}${failed || expired ? " · Showing stale results" : ""}`}
    </p>
  );
}

export function ProjectCiPage() {
  return (
    <SidebarInset>
      <ProjectCiContent />
    </SidebarInset>
  );
}

function CiRunRow({
  target,
  run: summary,
  projectTitle,
  repository,
}: {
  readonly target: RunTarget;
  readonly run: Run;
  readonly projectTitle: string;
  readonly repository: string;
}) {
  const [open, setOpen] = useState(false);
  const result = useAtomValue(runView(open ? target : null));
  const details = result.data?.run;
  const run = details ?? summary;
  const refresh = () => {
    if (open && !result.pending) appAtomRegistry.refresh(runQuery(target));
  };
  useLiveRefresh(refresh, {
    enabled: open,
    key: JSON.stringify(["project-ci-run", target]),
    intervalMs: 60_000,
  });
  return (
    <details className="rounded border p-3" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer">
        <span className="font-medium">{run.name}</span>
        <span className="ml-2 text-sm text-muted-foreground">
          {run.conclusion ?? run.status} · {run.branch ?? run.sha.slice(0, 7)} ·{" "}
          {new Date(run.createdAt).toLocaleString()} · {projectTitle} · {repository}
        </span>
      </summary>
      {open && (
        <div className="mt-3 flex flex-col gap-2 text-sm">
          <a href={run.url} target="_blank" rel="noreferrer" className="underline">
            Open run
          </a>
          <Button size="sm" variant="outline" disabled={result.pending} onClick={refresh}>
            Refresh details
          </Button>
          <PipelineFreshness
            fetchedAt={result.data?.fetchedAt ?? null}
            failed={result.error !== null}
          />
          {result.pending && <span>Loading run details...</span>}
          {result.error && <span role="alert">{result.error}</span>}
          {details?.jobsError && (
            <span role="alert">
              Some jobs could not be loaded ({details.jobsError}). More jobs, including failures,
              may be available. Refresh or open the run to retry.
            </span>
          )}
          {details?.jobsTruncated && (
            <span role="status">
              Job limit reached. More jobs, including failures, may be available. Open the run to
              see all jobs.
            </span>
          )}
          {details?.jobs.map((job) => (
            <div key={job.url} className="flex justify-between gap-3">
              <a href={job.url} target="_blank" rel="noreferrer" className="underline">
                {job.name}
              </a>
              <span>{job.conclusion ?? job.status}</span>
            </div>
          ))}
          {details && details.jobs.length === 0 && !details.jobsError && (
            <span className="text-muted-foreground">No jobs available.</span>
          )}
        </div>
      )}
    </details>
  );
}
