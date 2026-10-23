import type { ProviderInstanceId } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type ProviderUsageScan,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import type { AcpRegistrySettings } from "../settings.ts";

/**
 * MiniMax Code leaves `model` empty on its usage rows, so every record is
 * attributed to the coding plan the CLI talks to.
 */
export const MINIMAX_USAGE_MODEL = "minimax-code";

/** Relative to the data directory, which `MINIMAX_DATA_DIR` moves away from `~/.minimax`. */
const MINIMAX_RUNTIME_DATABASE = ["v2", "sqlite", "runtime-state.sqlite"] as const;

export function isMinimaxCodeCommand(commandPath: string): boolean {
  const name = commandPath.trim().split(/[\\/]/).pop() ?? "";
  return name.replace(/\.(exe|cmd|bat)$/i, "") === "mcode";
}

export interface MinimaxUsageRow {
  readonly id: unknown;
  readonly session_id: unknown;
  readonly model: unknown;
  readonly ts: unknown;
  readonly input_tokens: unknown;
  readonly output_tokens: unknown;
  readonly reasoning_tokens: unknown;
  readonly cache_read_tokens: unknown;
  readonly cache_write_tokens: unknown;
}

export function parseMinimaxRow(row: MinimaxUsageRow, database: string): UsageRecord | null {
  if (typeof row.ts !== "number" || !Number.isFinite(row.ts)) return null;
  const reasoningTokens = tokenCount(row.reasoning_tokens);
  const totals = {
    // One row per model request; `input_tokens` already excludes cache reads.
    uncachedInputTokens: tokenCount(row.input_tokens),
    cachedInputTokens: tokenCount(row.cache_read_tokens),
    cacheCreationTokens: tokenCount(row.cache_write_tokens),
    outputTokens: tokenCount(row.output_tokens),
    reasoningTokens,
  };
  if (totalTokens(totals) === 0) return null;
  return {
    provider: "minimax",
    timestampMs: row.ts,
    model: typeof row.model === "string" && row.model.length > 0 ? row.model : MINIMAX_USAGE_MODEL,
    sessionId: typeof row.session_id === "string" ? row.session_id : "",
    totals,
    // The plan is prepaid and the CLI records zero cost for every request.
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: typeof row.id === "number" ? `minimax:${database}:${row.id}` : null,
  };
}

const readDatabase = Effect.fn("minimaxUsageReader.readDatabase")(function* (
  database: string,
  sinceMs: number,
) {
  const sql = yield* SqlClient.SqlClient;
  // MiniMax Code may be writing; fail this source fast instead of stalling on its lock.
  yield* sql.unsafe("PRAGMA busy_timeout = 100");
  const rows = yield* sql.unsafe<MinimaxUsageRow>(
    `SELECT id, session_id, model, ts, input_tokens, output_tokens, reasoning_tokens,
            cache_read_tokens, cache_write_tokens
     FROM local_runtime_token_usage WHERE ts >= ? ORDER BY id`,
    [sinceMs],
  );
  return rows.flatMap((row) => {
    const record = parseMinimaxRow(row, database);
    return record === null ? [] : [record];
  });
});

export const minimaxUsageReader: Extract<
  ProviderUsageReader<AcpRegistrySettings, FileSystem.FileSystem | Path.Path>,
  { readonly kind: "scan" }
> = {
  kind: "scan",
  provider: "minimax",
  scan: Effect.fn("minimaxUsageReader.scan")(function* ({
    instances,
    windowStartMs,
    retentionCutoffMs,
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;

    // Instances sharing a data directory share one database and its attribution.
    const owners = new Map<string, ProviderInstanceId[]>();
    for (const instance of instances) {
      if (!instance.configured || instance.config === undefined) continue;
      if (!isMinimaxCodeCommand(instance.config.commandPath)) continue;
      const configured = instance.environment["MINIMAX_DATA_DIR"]?.trim();
      const dataDir = path.resolve(
        configured ? expandHomePath(configured, homeDirectory) : path.join(homeDirectory, ".minimax"),
      );
      owners.set(dataDir, [...(owners.get(dataDir) ?? []), instance.instanceId]);
    }

    const sinceMs = Math.min(windowStartMs, retentionCutoffMs);
    return yield* Effect.forEach(
      owners,
      Effect.fnUntraced(function* ([dir, instanceIds]) {
        const database = path.join(dir, ...MINIMAX_RUNTIME_DATABASE);
        const exists = yield* fileSystem.exists(database).pipe(Effect.orElseSucceed(() => false));
        if (!exists) return { dir, files: null, instanceIds } satisfies ProviderUsageScan;
        return yield* readDatabase(database, sinceMs).pipe(
          Effect.provide(NodeSqliteClient.layer({ filename: database, readonly: true })),
          Effect.map(
            (records): ProviderUsageScan => ({
              dir,
              files: [{ path: database, records }],
              status: "ok",
              instanceIds,
            }),
          ),
          Effect.catchTags({
            SqlError: () =>
              Effect.succeed({
                dir,
                files: [],
                status: "partial",
                message: "MiniMax Code usage could not be read.",
                instanceIds,
              } satisfies ProviderUsageScan),
          }),
        );
      }),
      { concurrency: "unbounded" },
    );
  }),
};
