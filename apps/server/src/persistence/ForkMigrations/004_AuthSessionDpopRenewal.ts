import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
  if (!columns.some((column) => column.name === "proof_key_thumbprint")) {
    yield* sql`ALTER TABLE auth_sessions ADD COLUMN proof_key_thumbprint TEXT`;
  }
  if (!columns.some((column) => column.name === "predecessor_session_id")) {
    yield* sql`ALTER TABLE auth_sessions ADD COLUMN predecessor_session_id TEXT`;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_proof_key_family
    ON auth_sessions(proof_key_thumbprint, subject)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_predecessor
    ON auth_sessions(predecessor_session_id)
  `;
});
