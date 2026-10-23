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
