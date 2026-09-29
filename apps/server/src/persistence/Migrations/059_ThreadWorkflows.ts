import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_workflows (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'failed', 'cancelled')),
      current_step INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_workflow_steps (
      workflow_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
      attempt INTEGER NOT NULL DEFAULT 1,
      result TEXT,
      started_at TEXT,
      completed_at TEXT,
      PRIMARY KEY (workflow_id, step_index),
      FOREIGN KEY (workflow_id) REFERENCES thread_workflows(id) ON DELETE CASCADE
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_workflows_runnable
    ON thread_workflows(status, updated_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_workflows_thread
    ON thread_workflows(thread_id, created_at DESC)
  `;
});
