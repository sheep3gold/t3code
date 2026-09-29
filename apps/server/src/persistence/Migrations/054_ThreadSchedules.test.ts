import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("054_ThreadSchedules", (it) => {
  it.effect("creates the persistent schedule table and due index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });

      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(thread_schedules)`;
      const names = new Set(columns.map((column) => column.name));
      assert.ok(names.has("thread_id"));
      assert.ok(names.has("schedule_kind"));
      assert.ok(names.has("next_run_at"));
      assert.ok(names.has("status"));

      const indexes = yield* sql<{ readonly name: string }>`PRAGMA index_list(thread_schedules)`;
      assert.ok(indexes.some((index) => index.name === "idx_thread_schedules_due"));
      assert.ok(indexes.some((index) => index.name === "idx_thread_schedules_thread"));
    }),
  );
});
