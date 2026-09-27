import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE thread_schedules_v61 (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('once', 'interval', 'cron')),
      interval_seconds INTEGER,
      cron_expression TEXT,
      timezone TEXT,
      skip_dates_json TEXT NOT NULL DEFAULT '[]',
      next_run_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed')),
      last_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (schedule_kind = 'once' AND interval_seconds IS NULL AND cron_expression IS NULL AND timezone IS NULL) OR
        (schedule_kind = 'interval' AND interval_seconds >= 60 AND cron_expression IS NULL AND timezone IS NULL) OR
        (schedule_kind = 'cron' AND interval_seconds IS NULL AND cron_expression IS NOT NULL AND timezone IS NOT NULL)
      )
    )
  `;
  yield* sql`
    INSERT INTO thread_schedules_v61 (
      id, thread_id, prompt, schedule_kind, interval_seconds,
      cron_expression, timezone, skip_dates_json, next_run_at,
      status, last_run_at, created_at, updated_at
    )
    SELECT id, thread_id, prompt, schedule_kind, interval_seconds,
      NULL, NULL, '[]', next_run_at,
      status, last_run_at, created_at, updated_at
    FROM thread_schedules
  `;
  yield* sql`DROP TABLE thread_schedules`;
  yield* sql`ALTER TABLE thread_schedules_v61 RENAME TO thread_schedules`;
  yield* sql`
    CREATE INDEX idx_thread_schedules_due
    ON thread_schedules(status, next_run_at)
  `;
  yield* sql`
    CREATE INDEX idx_thread_schedules_thread
    ON thread_schedules(thread_id, created_at DESC)
  `;
});
