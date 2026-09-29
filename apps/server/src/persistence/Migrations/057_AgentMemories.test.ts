import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("057_AgentMemories", (it) => {
  it.effect("creates scoped explicit memory storage", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(agent_memories)`;
      const names = new Set(columns.map((column) => column.name));
      assert.ok(names.has("fingerprint"));
      assert.ok(names.has("scope"));
      assert.ok(names.has("project_id"));
      assert.ok(names.has("content"));
    }),
  );
});
