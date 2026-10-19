import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ThreadSchedules from "./Migrations/001_ThreadSchedules.ts";
import ThreadPullRequestMonitors from "./Migrations/002_ThreadPullRequestMonitors.ts";
import ThreadLedger from "./Migrations/003_ThreadLedger.ts";
import AgentMemories from "./Migrations/004_AgentMemories.ts";
import Artifacts from "./Migrations/005_Artifacts.ts";
import ThreadWorkflows from "./Migrations/006_ThreadWorkflows.ts";
import ThreadWorkflowDag from "./Migrations/007_ThreadWorkflowDag.ts";
import ThreadScheduleCron from "./Migrations/008_ThreadScheduleCron.ts";
import AuthSessionClientInstalledAt from "./Migrations/009_AuthSessionClientInstalledAt.ts";

/**
 * Fork-only schema lives in its own migrations table. Upstream's migrator
 * skips every id up to the highest recorded one, so sharing
 * `effect_sql_migrations` would make each upstream migration added after a
 * fork migration silently never run.
 */
export const FORK_MIGRATIONS_TABLE = "fork_sql_migrations";

export const forkMigrationEntries = [
  [1, "ThreadSchedules", ThreadSchedules],
  [2, "ThreadPullRequestMonitors", ThreadPullRequestMonitors],
  [3, "ThreadLedger", ThreadLedger],
  [4, "AgentMemories", AgentMemories],
  [5, "Artifacts", Artifacts],
  [6, "ThreadWorkflows", ThreadWorkflows],
  [7, "ThreadWorkflowDag", ThreadWorkflowDag],
  [8, "ThreadScheduleCron", ThreadScheduleCron],
  [9, "AuthSessionClientInstalledAt", AuthSessionClientInstalledAt],
] as const;

/**
 * Before upstream adopted V2 the fork recorded its own migrations at ids
 * 54-64 of `effect_sql_migrations`, where upstream now keeps V2. Upstream
 * refuses to start on that history, so move the fork entries to the fork
 * table, keeping the schema they built, and let upstream's 54+ run.
 */
const LEGACY_FORK_HISTORY: ReadonlyMap<number, string> = new Map([
  [54, "ThreadSchedules"],
  [55, "ThreadPullRequestMonitors"],
  [56, "ThreadLedger"],
  [57, "AgentMemories"],
  [58, "Artifacts"],
  [59, "ThreadWorkflows"],
  [60, "ThreadWorkflowDag"],
  [61, "ThreadScheduleCron"],
  [62, "ProjectionThreadsLastReadAt"],
  [63, "AuthSessionClientInstalledAt"],
  [64, "McpAppModelContext"],
]);

export const reconcileLegacyForkMigrationHistory = Effect.fn("reconcileLegacyForkMigrationHistory")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
        if (tables.length === 0) return [];
        const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 54
      `;
        const legacy = history.filter(
          (row) => LEGACY_FORK_HISTORY.get(row.migration_id) === row.name,
        );
        if (legacy.length === 0) return [];
        if (legacy.length !== history.length) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: `Migration history mixes legacy fork and upstream entries at ids 54+: ${history
              .map((row) => `${row.migration_id}:${row.name}`)
              .join(", ")}.`,
          });
        }

        // The fork built this table keyed by tool call; upstream's own migration
        // only creates it when absent, so a fork-shaped copy would survive and
        // break upstream's queries. It holds per-turn UI context that is safe to lose.
        const contextColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(mcp_app_model_context)
      `;
        if (contextColumns.some((column) => column.name === "tool_call_id")) {
          yield* sql`DROP TABLE mcp_app_model_context`;
        }

        yield* sql`
        CREATE TABLE IF NOT EXISTS ${sql(FORK_MIGRATIONS_TABLE)} (
          migration_id integer PRIMARY KEY NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp,
          name VARCHAR(255) NOT NULL
        )
      `;
        const carried: Array<readonly [number, string]> = [];
        for (const [id, name] of forkMigrationEntries) {
          if (!legacy.some((row) => row.name === name)) continue;
          yield* sql`
          INSERT OR IGNORE INTO ${sql(FORK_MIGRATIONS_TABLE)} (migration_id, name)
          VALUES (${id}, ${name})
        `;
          carried.push([id, name]);
        }
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 54`;
        return carried;
      }),
    );
  },
);

const runForkMigrator = Migrator.make({});

export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const executed = yield* runForkMigrator({
    table: FORK_MIGRATIONS_TABLE,
    loader: Migrator.fromRecord(
      Object.fromEntries(
        forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
  if (executed.length > 0) {
    yield* Effect.log("Fork migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});
