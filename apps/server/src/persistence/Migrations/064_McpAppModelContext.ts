import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS mcp_app_model_context (
      thread_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      server TEXT NOT NULL,
      tool TEXT NOT NULL,
      text TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, tool_call_id)
    )
  `;
});
