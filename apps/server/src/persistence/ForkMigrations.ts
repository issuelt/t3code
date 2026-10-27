import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest } from "./Migrations.ts";
import ForkMigration0001 from "./ForkMigrations/001_TaskGraphs.ts";
import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import AutoSettleDisabledAt from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";

/**
 * Fork migrations use their own table: upstream's migrator skips every id up
 * to the highest recorded, so fork rows in `effect_sql_migrations` would hide
 * later upstream migrations. Append fork migrations here, never `Migrations.ts`.
 */
const forkMigrationEntries = [[1, "TaskGraphs", ForkMigration0001]] as const;

const FORK_MIGRATIONS_TABLE = "fork_sql_migrations";

const runFork = Migrator.make({});

export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const executed = yield* runFork({
    table: FORK_MIGRATIONS_TABLE,
    loader: Migrator.fromRecord(
      Object.fromEntries(
        forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
  if (executed.length > 0) {
    yield* Effect.log("Fork migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});

// Fork-only migrations that older fork builds recorded in effect_sql_migrations.
const LEGACY_FORK_MIGRATIONS = new Set(["ProjectionThreadShellActivitySummary", "TaskGraphs"]);

const PREVIEW_GAP_MIGRATIONS = [
  ["PullRequestFilesViewed", PullRequestFilesViewed],
  ["ProjectionThreadsAutoSettleDisabledAt", AutoSettleDisabledAt],
] as const;

/**
 * Rewrites older fork histories (fork rows mixed in, upstream ids shifted) to
 * upstream's ids by name. Fork rows are dropped and re-run idempotently by the
 * fork migrator. Must run before upstream's migrator; no-op on upstream shape.
 */
export const reconcileForkMigrationHistory = Effect.fn("reconcileForkMigrationHistory")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
        `;
        if (tables.length === 0) return false;
        const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations
        `;
        // Fork builds put OrchestrationV2 at 56; upstream has it at 55.
        const isForkHistory = recorded.some(
          (row) =>
            LEGACY_FORK_MIGRATIONS.has(row.name) ||
            (row.name === "OrchestrationV2" && row.migration_id === 56),
        );
        if (!isForkHistory) return false;

        const upstreamIds = new Map<string, number>(
          migrationManifest.map(([id, name]) => [name, id]),
        );
        const names = new Set(
          recorded.map((row) => row.name).filter((name) => !LEGACY_FORK_MIGRATIONS.has(name)),
        );
        // Fork previews recorded V2 before these two existed. Both are
        // idempotent, so run the missing ones instead of leaving a gap.
        if (names.has("OrchestrationV2")) {
          for (const [name, migration] of PREVIEW_GAP_MIGRATIONS) {
            if (names.has(name)) continue;
            yield* migration;
            names.add(name);
          }
        }
        const unknown = [...names].filter((name) => !upstreamIds.has(name));
        const rows = [...names]
          .flatMap((name) => {
            const id = upstreamIds.get(name);
            return id === undefined ? [] : [{ id, name }];
          })
          .toSorted((a, b) => a.id - b.id);
        // A gap would make upstream's migrator skip the missing migration.
        const gapless = rows.every((row, index) => row.id === index + 1);
        if (unknown.length > 0 || !gapless) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: `Cannot map this fork database's migration history onto upstream ids. Unknown: ${unknown.join(", ") || "none"}; mapped ids: ${rows.map((row) => row.id).join(", ")}.`,
          });
        }

        yield* sql`DELETE FROM effect_sql_migrations`;
        for (const { id, name } of rows) {
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
        }
        yield* Effect.log("Rewrote fork migration history to upstream ids");
        return true;
      }),
    );
  },
);
