import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("060_ThreadWorkflowDag", (it) => {
  it.effect("adds isolation metadata and backfills sequential dependencies", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 59 });
      yield* sql`
        INSERT INTO thread_workflows (id, thread_id, name, status, current_step, created_at, updated_at)
        VALUES ('legacy', 'thread-1', 'Legacy', 'running', 0, '2026-09-27T00:00:00Z', '2026-09-27T00:00:00Z')
      `;
      yield* sql`
        INSERT INTO thread_workflow_steps (workflow_id, step_index, title, prompt, status, attempt)
        VALUES ('legacy', 0, 'One', 'One', 'pending', 1),
               ('legacy', 1, 'Two', 'Two', 'pending', 1),
               ('legacy', 2, 'Three', 'Three', 'pending', 1)
      `;
      yield* runMigrations({ toMigrationInclusive: 60 });
      const rows = yield* sql<{ readonly stepIndex: number; readonly dependsOn: string }>`
        SELECT step_index AS "stepIndex", depends_on_json AS "dependsOn"
        FROM thread_workflow_steps WHERE workflow_id = 'legacy' ORDER BY step_index
      `;
      assert.deepStrictEqual(rows, [
        { stepIndex: 0, dependsOn: "[]" },
        { stepIndex: 1, dependsOn: "[0]" },
        { stepIndex: 2, dependsOn: "[1]" },
      ]);
      const columns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(thread_workflow_steps)`;
      assert.includeMembers(
        columns.map(({ name }) => name),
        ["depends_on_json", "child_thread_id", "worktree_path", "branch"],
      );
    }),
  );
});
