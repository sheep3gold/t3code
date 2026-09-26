import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_pr_monitor_state (
      thread_id TEXT NOT NULL,
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      number INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'terminal')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, host, repository, number)
    ) WITHOUT ROWID
  `;
});
