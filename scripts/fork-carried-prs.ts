#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// Reports how each upstream PR the fork carries (.github/fork/carried-prs.json) has moved
// since we took it. Exits non-zero when any PR is no longer open at the head we took.

const CarriedPr = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  takenSha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  reason: Schema.NonEmptyString,
  note: Schema.optional(Schema.String),
  // Upstream closed it unmerged and the fork now owns it; only a moved head is drift.
  closedUpstream: Schema.optional(Schema.Literal(true)),
});
type CarriedPr = typeof CarriedPr.Type;

const CarriedPrsManifest = Schema.Struct({
  upstream: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
  prs: Schema.Array(CarriedPr),
});

const UpstreamPullRequest = Schema.Struct({
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  headRefOid: Schema.String,
  commits: Schema.Struct({
    totalCount: Schema.Int,
    nodes: Schema.Array(Schema.Struct({ commit: Schema.Struct({ oid: Schema.String }) })),
  }),
});
type UpstreamPullRequest = typeof UpstreamPullRequest.Type;

const PullRequestQueryResponse = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Record(Schema.String, UpstreamPullRequest),
  }),
});

const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(CarriedPrsManifest));
const decodeQueryResponse = Schema.decodeEffect(Schema.fromJsonString(PullRequestQueryResponse));

export type CarriedPrStatus =
  | { readonly kind: "unchanged" }
  // "rewritten": the taken commit left the PR's history (force-push or rebase).
  // "unknown": the PR has more commits than the query returned.
  | { readonly kind: "new-commits"; readonly newCommits: number | "rewritten" | "unknown" }
  | { readonly kind: "merged" }
  | { readonly kind: "closed-unmerged" };

export function classifyCarriedPr(
  { takenSha, closedUpstream }: Pick<CarriedPr, "takenSha" | "closedUpstream">,
  pr: UpstreamPullRequest,
): CarriedPrStatus {
  if (pr.state === "MERGED") return { kind: "merged" };
  if (pr.state === "CLOSED" && !(closedUpstream && pr.headRefOid === takenSha)) {
    return { kind: "closed-unmerged" };
  }
  if (pr.headRefOid === takenSha) return { kind: "unchanged" };
  const oids = pr.commits.nodes.map((node) => node.commit.oid);
  const taken = oids.lastIndexOf(takenSha);
  if (taken !== -1) return { kind: "new-commits", newCommits: oids.length - 1 - taken };
  return {
    kind: "new-commits",
    newCommits: oids.length === pr.commits.totalCount ? "rewritten" : "unknown",
  };
}

function formatStatus(status: CarriedPrStatus): string {
  if (status.kind !== "new-commits") return status.kind;
  const { newCommits } = status;
  return typeof newCommits === "number"
    ? `new-commits (+${newCommits})`
    : `new-commits (${newCommits})`;
}

function renderTable(
  upstream: string,
  rows: ReadonlyArray<{ entry: CarriedPr; pr: UpstreamPullRequest; status: CarriedPrStatus }>,
): string {
  const lines = rows.map(
    ({ entry, pr, status }) =>
      `| [#${entry.number}](https://github.com/${upstream}/pull/${entry.number}) | ${formatStatus(status)} | ${entry.takenSha.slice(0, 10)} | ${pr.headRefOid.slice(0, 10)} | ${entry.reason} |`,
  );
  return [
    "| PR | Status | Taken | Head | Reason |",
    "| --- | --- | --- | --- | --- |",
    ...lines,
  ].join("\n");
}

export class CarriedPrsDriftedError extends Schema.TaggedError<CarriedPrsDriftedError>()(
  "CarriedPrsDriftedError",
  { drifted: Schema.Int, total: Schema.Int },
) {
  override get message(): string {
    return `${this.drifted} of ${this.total} carried upstream PRs changed upstream.`;
  }
}

const readUpstreamPullRequests = Effect.fn("forkCarriedPrs.readUpstreamPullRequests")(function* (
  upstream: string,
  numbers: ReadonlyArray<number>,
) {
  const [owner = "", name = ""] = upstream.split("/");
  const fields = numbers
    .map(
      (number) =>
        `pr${number}: pullRequest(number: ${number}) { state headRefOid commits(last: 100) { totalCount nodes { commit { oid } } } }`,
    )
    .join("\n");
  const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* spawner.string(
    ChildProcess.make(
      "gh",
      ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`],
      { stderr: "inherit" },
    ),
  );
  return (yield* decodeQueryResponse(output)).data.repository;
});

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const manifest = yield* decodeManifest(
    yield* fs.readFileString(path.join(root, ".github/fork/carried-prs.json")),
  );
  const pullRequests = yield* readUpstreamPullRequests(
    manifest.upstream,
    manifest.prs.map((entry) => entry.number),
  );
  const rows = manifest.prs.flatMap((entry) => {
    const pr = pullRequests[`pr${entry.number}`];
    return pr ? [{ entry, pr, status: classifyCarriedPr(entry, pr) }] : [];
  });
  yield* Console.log(renderTable(manifest.upstream, rows));
  // A PR missing from the response counts as drifted.
  const total = manifest.prs.length;
  const drifted = total - rows.filter((row) => row.status.kind === "unchanged").length;
  if (drifted > 0) {
    return yield* new CarriedPrsDriftedError({ drifted, total });
  }
});

if (import.meta.main) {
  main.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
