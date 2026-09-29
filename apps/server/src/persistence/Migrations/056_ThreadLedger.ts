import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_ledger_state (
      thread_id TEXT PRIMARY KEY,
      goal TEXT,
      phase TEXT,
      next_step TEXT,
      artifacts_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_ledger_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_ledger_events_recent
    ON thread_ledger_events(thread_id, id DESC)
  `;
});
