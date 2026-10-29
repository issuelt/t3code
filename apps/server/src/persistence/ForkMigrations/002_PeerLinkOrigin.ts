import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Older fork builds ran this as upstream migration 72; reconcile re-runs it here.
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(peer_environment_links)`;
  if (columns.some((column) => column.name === "trusted_origin")) return;
  yield* sql`ALTER TABLE peer_environment_links ADD COLUMN trusted_origin TEXT`;
});
