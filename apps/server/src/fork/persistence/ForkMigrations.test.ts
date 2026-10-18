import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../../persistence/Migrations.ts";
import {
  FORK_MIGRATIONS_TABLE,
  forkMigrationEntries,
  reconcileLegacyForkMigrationHistory,
  runForkMigrations,
} from "./ForkMigrations.ts";

const legacyForkNames = [
  "ThreadSchedules",
  "ThreadPullRequestMonitors",
  "ThreadLedger",
  "AgentMemories",
  "Artifacts",
  "ThreadWorkflows",
  "ThreadWorkflowDag",
  "ThreadScheduleCron",
  "ProjectionThreadsLastReadAt",
  "AuthSessionClientInstalledAt",
  "McpAppModelContext",
];

// Reproduces a database written by the V1 fork: upstream schema through 53,
// fork schema recorded at 54-64 of upstream's table.
const seedLegacyFork = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 53 });
  for (const [, , migration] of forkMigrationEntries) yield* migration;
  yield* sql`
    CREATE TABLE mcp_app_model_context (
      thread_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, text TEXT NOT NULL,
      PRIMARY KEY (thread_id, tool_call_id)
    )
  `;
  for (const [index, name] of legacyForkNames.entries()) {
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${54 + index}, ${name})`;
  }
  yield* sql`
    INSERT INTO agent_memories
      (id, fingerprint, kind, scope, content, source_thread_id, created_at, updated_at)
    VALUES ('m1', 'f1', 'memory', 'global', 'keep me', 't1', '2026-10-01', '2026-10-01')
  `;
});

const migrate = Effect.gen(function* () {
  const carried = yield* reconcileLegacyForkMigrationHistory();
  const upstream = yield* runMigrations();
  const fork = yield* runForkMigrations();
  return { carried, upstream, fork };
});

describe("fork migration history", () => {
  it.effect("upgrades a V1 fork database onto upstream V2 without losing fork data", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyFork;

      const first = yield* migrate;
      assert.deepStrictEqual(
        first.carried.map(([id]) => id),
        forkMigrationEntries.map(([id]) => id),
      );
      assert.deepStrictEqual(
        first.upstream.map(([id]) => id),
        migrationManifest.filter(([id]) => id >= 54).map(([id]) => id),
      );
      assert.deepStrictEqual(first.fork, []);

      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      const contextColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(mcp_app_model_context)
      `;
      assert.isTrue(contextColumns.some((column) => column.name === "item_id"));
      assert.deepStrictEqual(yield* sql`SELECT content FROM agent_memories`, [
        { content: "keep me" },
      ]);

      assert.deepStrictEqual(yield* migrate, { carried: [], upstream: [], fork: [] });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("builds fork schema in its own table on a fresh database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const result = yield* migrate;
      assert.deepStrictEqual(result.carried, []);
      assert.deepStrictEqual(
        result.fork,
        forkMigrationEntries.map(([id, name]) => [id, name] as const),
      );
      const recorded = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM ${sql(FORK_MIGRATIONS_TABLE)}
      `;
      assert.strictEqual(recorded[0]?.count, forkMigrationEntries.length);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
