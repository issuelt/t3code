import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { reconcileForkMigrationHistory, runForkMigrations } from "./ForkMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const migrateAll = Effect.gen(function* () {
  yield* reconcileForkMigrationHistory();
  yield* runMigrations();
  yield* runForkMigrations();
});

// Rewrites an upstream history through 62 into the shape an older fork build left.
const shiftUp = (from: number, to: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (let id = to; id >= from; id--) {
      yield* sql`UPDATE effect_sql_migrations SET migration_id = ${id + 1} WHERE migration_id = ${id}`;
    }
  });

const expectUpstreamHistoryAndTaskGraphs = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  assert.deepStrictEqual(yield* history, migrationManifest);
  const fork = yield* sql<{ readonly name: string }>`SELECT name FROM fork_sql_migrations`;
  assert.deepStrictEqual(
    fork.map((row) => row.name),
    ["TaskGraphs"],
  );
  const tables = yield* sql`SELECT name FROM sqlite_master WHERE name = 'task_graphs'`;
  assert.strictEqual(tables.length, 1);
});

const memory = NodeSqliteClient.layer({ filename: ":memory:" });

describe("fork migrations", () => {
  it.effect("upgrades a fresh fork install's shifted history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* shiftUp(33, 62);
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (33, 'ProjectionThreadShellActivitySummary')`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (64, 'TaskGraphs')`;

      yield* migrateAll;
      yield* expectUpstreamHistoryAndTaskGraphs;
    }).pipe(Effect.provide(memory)),
  );

  it.effect("upgrades a reconciled V2 preview history with a duplicate id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* shiftUp(55, 62);
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'ProjectionThreadsAutoSettleDisabledAt')`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (64, 'TaskGraphs')`;

      yield* migrateAll;
      yield* expectUpstreamHistoryAndTaskGraphs;
    }).pipe(Effect.provide(memory)),
  );

  it.effect("upgrades a fork preview that recorded V2 before migrations 53 and 54", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id IN (53, 54)`;
      yield* sql`DROP TABLE pull_request_files_viewed`;
      yield* sql`ALTER TABLE projection_threads DROP COLUMN auto_settle_disabled_at`;
      yield* shiftUp(33, 52);
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 54 WHERE migration_id = 55`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (33, 'ProjectionThreadShellActivitySummary')`;

      yield* migrateAll;
      yield* expectUpstreamHistoryAndTaskGraphs;
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.isTrue(columns.some((column) => column.name === "auto_settle_disabled_at"));
      const viewed =
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'pull_request_files_viewed'`;
      assert.strictEqual(viewed.length, 1);
    }).pipe(Effect.provide(memory)),
  );

  it.effect("preserves historical graph and peer rows when migrations run again", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrateAll;
      yield* sql`INSERT INTO task_graphs VALUES ('graph-1', 'project-1', 'thread-1', 'completed', '{"nodes":[]}', '2026-01-01', '2026-01-01')`;
      yield* sql`INSERT INTO task_graph_peers VALUES ('peer-1', 'Peer', 'https://example.test', 1, '2026-01-01')`;
      yield* migrateAll;
      const graphs = yield* sql<{
        readonly graph_json: string;
      }>`SELECT graph_json FROM task_graphs WHERE graph_id = 'graph-1'`;
      const peers = yield* sql<{
        readonly label: string;
      }>`SELECT label FROM task_graph_peers WHERE environment_id = 'peer-1'`;
      assert.deepStrictEqual(
        graphs.map((row) => row.graph_json),
        ['{"nodes":[]}'],
      );
      assert.deepStrictEqual(
        peers.map((row) => row.label),
        ["Peer"],
      );
    }).pipe(Effect.provide(memory)),
  );

  it.effect("leaves an upstream history alone", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 62 });
      const before = yield* history;
      assert.isFalse(yield* reconcileForkMigrationHistory());
      assert.deepStrictEqual(yield* history, before);

      yield* migrateAll;
      yield* expectUpstreamHistoryAndTaskGraphs;
    }).pipe(Effect.provide(memory)),
  );

  it.effect("refuses a fork history with a gap", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 40`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (64, 'TaskGraphs')`;
      const before = yield* history;

      const exit = yield* Effect.exit(reconcileForkMigrationHistory());
      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(memory)),
  );
});
