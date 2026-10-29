import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS coordination_requests (
    request_message_id TEXT PRIMARY KEY,
    requester_thread_id TEXT NOT NULL,
    responder_environment_id TEXT NOT NULL,
    responder_thread_id TEXT NOT NULL,
    origin_run_id TEXT,
    owner TEXT NOT NULL CHECK (owner IN ('job', 'coordination'))
  )`;
});
