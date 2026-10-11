import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateLastReadAt from "./062_ProjectionThreadsLastReadAt.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("062_ProjectionThreadsLastReadAt", (it) => {
  it.effect("seeds read state from the latest completion without touching timestamps", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 61 });
      const now = "2026-01-01T00:00:00.000Z";
      const completedAt = "2026-01-01T00:05:00.000Z";
      for (const [threadId, latestTurnId] of [
        ["thread-completed", "turn-2"],
        ["thread-running", "turn-3"],
        ["thread-empty", null],
      ] as const) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            latest_turn_id, created_at, updated_at
          ) VALUES (
            ${threadId}, 'project-1', 'Existing thread',
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access',
            ${latestTurnId}, ${now}, ${now}
          )
        `;
      }
      for (const [threadId, turnId, state, turnCompletedAt] of [
        ["thread-completed", "turn-1", "completed", "2026-01-01T00:01:00.000Z"],
        ["thread-completed", "turn-2", "completed", completedAt],
        ["thread-running", "turn-3", "running", null],
      ] as const) {
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, state, requested_at, completed_at, checkpoint_files_json
          ) VALUES (${threadId}, ${turnId}, ${state}, ${now}, ${turnCompletedAt}, '[]')
        `;
      }
      yield* runMigrations({ toMigrationInclusive: 62 });
      const migrated = yield* sql<{
        readonly threadId: string;
        readonly lastReadAt: string | null;
        readonly updatedAt: string;
      }>`
        SELECT thread_id AS "threadId", last_read_at AS "lastReadAt", updated_at AS "updatedAt"
        FROM projection_threads ORDER BY thread_id
      `;
      assert.deepEqual(migrated, [
        { threadId: "thread-completed", lastReadAt: completedAt, updatedAt: now },
        { threadId: "thread-empty", lastReadAt: null, updatedAt: now },
        { threadId: "thread-running", lastReadAt: null, updatedAt: now },
      ]);
      // Re-running against a database that already has the column must not
      // overwrite reads recorded after the upgrade.
      const readAt = "2026-01-02T00:00:00.000Z";
      yield* sql`UPDATE projection_threads SET last_read_at = ${readAt} WHERE thread_id = 'thread-completed'`;
      yield* migrateLastReadAt;
      const rows = yield* sql<{ readonly lastReadAt: string | null }>`
        SELECT last_read_at AS "lastReadAt" FROM projection_threads WHERE thread_id = 'thread-completed'
      `;
      assert.deepEqual(rows, [{ lastReadAt: readAt }]);
    }),
  );
});
