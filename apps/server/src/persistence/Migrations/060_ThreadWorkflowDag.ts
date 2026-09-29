import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE thread_workflow_steps ADD COLUMN depends_on_json TEXT NOT NULL DEFAULT '[]'`;
  yield* sql`ALTER TABLE thread_workflow_steps ADD COLUMN child_thread_id TEXT`;
  yield* sql`ALTER TABLE thread_workflow_steps ADD COLUMN worktree_path TEXT`;
  yield* sql`ALTER TABLE thread_workflow_steps ADD COLUMN branch TEXT`;
  yield* sql`
    UPDATE thread_workflow_steps
    SET depends_on_json = printf('[%d]', step_index - 1)
    WHERE step_index > 0
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_workflow_steps_child
    ON thread_workflow_steps(child_thread_id)
  `;
});
