import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_schedules (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('once', 'interval')),
      interval_seconds INTEGER,
      next_run_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed')),
      last_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (schedule_kind = 'once' AND interval_seconds IS NULL) OR
        (schedule_kind = 'interval' AND interval_seconds >= 60)
      )
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_schedules_due
    ON thread_schedules(status, next_run_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_schedules_thread
    ON thread_schedules(thread_id, created_at DESC)
  `;
});
