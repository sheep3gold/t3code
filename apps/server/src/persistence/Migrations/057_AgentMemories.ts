import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_memories (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('lesson', 'memory')),
      scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
      project_id TEXT,
      content TEXT NOT NULL,
      negative TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      source_thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (scope = 'global' AND project_id IS NULL) OR
        (scope = 'project' AND project_id IS NOT NULL)
      )
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_memories_scope
    ON agent_memories(kind, scope, project_id, updated_at DESC)
  `;
});
