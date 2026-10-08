import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN last_activity_summary TEXT
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN last_activity_at TEXT
  `.pipe(Effect.catch(() => Effect.void));

  // Backfill the shell summary from each thread's most recent work-log activity.
  yield* sql`
    WITH latest_activities AS (
      SELECT
        thread_id,
        summary,
        created_at,
        ROW_NUMBER() OVER (
          PARTITION BY thread_id
          ORDER BY created_at DESC, sequence DESC, activity_id DESC
        ) AS row_number
      FROM projection_thread_activities
    )
    UPDATE projection_threads
    SET
      last_activity_summary = (
        SELECT latest_activities.summary
        FROM latest_activities
        WHERE latest_activities.thread_id = projection_threads.thread_id
          AND latest_activities.row_number = 1
      ),
      last_activity_at = (
        SELECT latest_activities.created_at
        FROM latest_activities
        WHERE latest_activities.thread_id = projection_threads.thread_id
          AND latest_activities.row_number = 1
      )
    WHERE EXISTS (
      SELECT 1
      FROM projection_thread_activities
      WHERE projection_thread_activities.thread_id = projection_threads.thread_id
    )
  `;
});
