import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { AcpRegistrySettings } from "../settings.ts";
import { isMinimaxCodeCommand, minimaxUsageReader } from "./minimaxUsage.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

const openDatabase = (filename: string) =>
  Layer.build(NodeSqliteClient.layer({ filename })).pipe(
    Effect.map(Context.get(SqlClient.SqlClient)),
  );

const instance = (id: string, commandPath: string, dataDir?: string) => ({
  instanceId: ProviderInstanceId.make(id),
  config: decodeSettings({ commandPath }),
  environment: dataDir === undefined ? {} : { MINIMAX_DATA_DIR: dataDir },
  configured: true,
});

describe("MiniMax Code usage", () => {
  it("selects only the mcode command", () => {
    assert.isTrue(isMinimaxCodeCommand("/home/ubuntu/.local/bin/mcode"));
    assert.isTrue(isMinimaxCodeCommand("C:\\tools\\mcode.exe"));
    assert.isFalse(isMinimaxCodeCommand("/home/ubuntu/.local/bin/kiro-cli"));
  });

  it.effect("reads per-request rows and attributes them to every instance on that data dir", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dataDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "minimax-usage-" });
      const sqliteDir = path.join(dataDir, "v2", "sqlite");
      yield* fileSystem.makeDirectory(sqliteDir, { recursive: true });
      const db = yield* openDatabase(path.join(sqliteDir, "runtime-state.sqlite"));
      yield* db.unsafe(
        `CREATE TABLE local_runtime_token_usage (id INTEGER PRIMARY KEY, session_id TEXT, model TEXT,
          ts INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
          cache_read_tokens INTEGER, cache_write_tokens INTEGER)`,
      );
      const since = 1792600000000;
      const insert = (ts: number, input: number, output: number, cacheRead: number) =>
        db.unsafe(
          `INSERT INTO local_runtime_token_usage (session_id, model, ts, input_tokens, output_tokens,
            reasoning_tokens, cache_read_tokens, cache_write_tokens) VALUES ('s', NULL, ?, ?, ?, 0, ?, 0)`,
          [ts, input, output, cacheRead],
        );
      yield* insert(since + 1, 530, 77, 347008);
      yield* insert(since + 2, 0, 0, 0);
      yield* insert(since - 1, 9, 9, 9);

      const scans = yield* minimaxUsageReader.scan({
        instances: [
          instance("minimax", "/home/ubuntu/.local/bin/mcode", dataDir),
          instance("minimax_alias", "mcode", dataDir),
          instance("kiro", "/home/ubuntu/.local/bin/kiro-cli", dataDir),
        ],
        settings: {} as never,
        windowStartMs: since,
        retentionCutoffMs: since,
        awaitRefresh: false,
      });

      assert.strictEqual(scans.length, 1);
      const [scan] = scans;
      assert.deepStrictEqual(scan?.instanceIds?.map(String), ["minimax", "minimax_alias"]);
      const records = scan?.files?.[0]?.records ?? [];
      assert.strictEqual(records.length, 1);
      assert.deepStrictEqual(records[0]?.totals, {
        uncachedInputTokens: 530,
        cachedInputTokens: 347008,
        cacheCreationTokens: 0,
        outputTokens: 77,
        reasoningTokens: 0,
      });
      assert.strictEqual(records[0]?.model, "minimax-code");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a missing database as no history rather than an error", () =>
    Effect.gen(function* () {
      const scans = yield* minimaxUsageReader.scan({
        instances: [instance("minimax", "mcode", "/nonexistent/minimax-home")],
        settings: {} as never,
        windowStartMs: 0,
        retentionCutoffMs: 0,
        awaitRefresh: false,
      });
      assert.strictEqual(scans[0]?.files, null);
    }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, "/nonexistent"),
      Effect.provide(NodeServices.layer),
    ),
  );
});
