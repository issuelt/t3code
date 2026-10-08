import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("033_ProjectionThreadShellActivitySummary", (it) => {
  it.effect("backfills last activity summary from the newest activity per thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });

      const insertThread = (threadId: string) => sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (
          ${threadId},
          'project-1',
          'Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:00.000Z',
          NULL,
          NULL,
          0,
          0,
          0,
          NULL
        )
      `;

      yield* insertThread("thread-with-activity");
      yield* insertThread("thread-without-activity");

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-old',
            'thread-with-activity',
            NULL,
            'info',
            'tool.invoked',
            'Editing config.ts',
            '{}',
            1,
            '2026-02-24T00:01:00.000Z'
          ),
          (
            'activity-new',
            'thread-with-activity',
            NULL,
            'info',
            'tool.invoked',
            'Running tests',
            '{}',
            2,
            '2026-02-24T00:02:00.000Z'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 33 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly lastActivitySummary: string | null;
        readonly lastActivityAt: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          last_activity_summary AS "lastActivitySummary",
          last_activity_at AS "lastActivityAt"
        FROM projection_threads
        ORDER BY thread_id ASC
      `;

      assert.deepStrictEqual(rows, [
        {
          threadId: "thread-with-activity",
          lastActivitySummary: "Running tests",
          lastActivityAt: "2026-02-24T00:02:00.000Z",
        },
        {
          threadId: "thread-without-activity",
          lastActivitySummary: null,
          lastActivityAt: null,
        },
      ]);
    }),
  );
});
