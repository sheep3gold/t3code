import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "../settings.ts";
import { isKiroCliCommand, kiroUsageReader, parseKiroSession } from "./kiroUsage.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

const instance = (id: string, commandPath: string, kiroHome?: string) => ({
  instanceId: ProviderInstanceId.make(id),
  config: decodeSettings({ commandPath }),
  environment: kiroHome === undefined ? {} : { KIRO_HOME: kiroHome },
  configured: true,
});

const sessionJson = (turns: readonly object[], windowTokens = 1_000_000) =>
  JSON.stringify({
    session_state: {
      rts_model_state: {
        model_info: { model_id: "auto", context_window_tokens: windowTokens },
      },
      conversation_metadata: { user_turn_metadatas: turns },
    },
  });

const turn = (
  endTimestamp: string,
  percentage: number | null,
  credits: readonly number[] = [],
  model = "auto",
) => ({
  end_timestamp: endTimestamp,
  final_context_usage_percentage: percentage,
  model,
  metering_usage: credits.map((value) => ({ value, unit: "credit", unitPlural: "credits" })),
});

describe("Kiro CLI usage", () => {
  it("selects only the kiro-cli command", () => {
    assert.isTrue(isKiroCliCommand("/home/ubuntu/.local/bin/kiro-cli"));
    assert.isTrue(isKiroCliCommand("C:\\tools\\kiro-cli.exe"));
    assert.isFalse(isKiroCliCommand("/home/ubuntu/.local/bin/mcode"));
    assert.isFalse(isKiroCliCommand("kimi"));
  });

  it("estimates tokens from occupancy growth and sums credits per turn", () => {
    const records = parseKiroSession(
      "s1",
      sessionJson([
        turn("2026-10-20T01:00:00Z", 10, [0.5]),
        turn("2026-10-20T02:00:00Z", 25, [0.25, 0.25]),
        // Compaction: occupancy drops, so the post-turn context is the bound.
        turn("2026-10-20T03:00:00Z", 5, [0.1]),
        turn("2026-10-20T04:00:00Z", 9, []),
      ]),
    );
    assert.strictEqual(records.length, 4);
    assert.strictEqual(records[0]?.totals.outputTokens, 100_000);
    assert.strictEqual(records[1]?.totals.outputTokens, 150_000);
    assert.strictEqual(records[2]?.totals.outputTokens, 50_000);
    assert.strictEqual(records[3]?.totals.outputTokens, 40_000);
    assert.strictEqual(records[0]?.credits, 0.5);
    assert.strictEqual(records[1]?.credits, 0.5);
    assert.strictEqual(records[2]?.credits, 0.1);
    assert.strictEqual(records[3]?.credits, null);
    assert.strictEqual(records[0]?.dedupeKey, "kiro:s1:0");
    assert.strictEqual(records[1]?.timestampMs, Date.parse("2026-10-20T02:00:00Z"));
  });

  it("keeps credit-only turns and skips turns without any signal", () => {
    const records = parseKiroSession(
      "s2",
      sessionJson([
        { end_timestamp: "2026-10-20T01:00:00Z", metering_usage: [{ value: 0.3, unit: "credit" }] },
        { end_timestamp: "2026-10-20T02:00:00Z" },
        { final_context_usage_percentage: 12 },
      ]),
    );
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0]?.credits, 0.3);
    assert.strictEqual(records[0]?.totals.outputTokens, 0);
  });

  it("returns nothing for malformed sessions", () => {
    assert.strictEqual(parseKiroSession("x", "not json").length, 0);
    assert.strictEqual(parseKiroSession("x", "{}").length, 0);
    assert.strictEqual(
      parseKiroSession("x", JSON.stringify({ session_state: { conversation_metadata: {} } }))
        .length,
      0,
    );
  });

  it.effect("reads session files and attributes them to every instance on that home", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kiro-usage-" });
      const sessionsDir = path.join(home, "sessions", "cli");
      yield* fileSystem.makeDirectory(sessionsDir, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(sessionsDir, "aaa.json"),
        sessionJson([turn("2026-10-20T01:00:00Z", 10, [0.5])]),
      );
      yield* fileSystem.writeFileString(
        path.join(sessionsDir, "bbb.json"),
        sessionJson([turn("2026-10-21T01:00:00Z", 20, [1])], 200_000),
      );
      yield* fileSystem.writeFileString(path.join(sessionsDir, "notes.txt"), "ignored");

      const scans = yield* kiroUsageReader.scan({
        instances: [
          instance("kiro", "/home/ubuntu/.local/bin/kiro-cli", home),
          instance("kiro_alias", "kiro-cli", home),
          instance("minimax", "mcode", home),
        ],
        settings: {} as never,
        windowStartMs: 0,
        retentionCutoffMs: 0,
        awaitRefresh: false,
      });

      assert.strictEqual(scans.length, 1);
      const [scan] = scans;
      assert.deepStrictEqual(scan?.instanceIds?.map(String), ["kiro", "kiro_alias"]);
      assert.strictEqual(scan?.files?.length, 2);
      const all = (scan?.files ?? []).flatMap((file) => file.records);
      assert.strictEqual(all.length, 2);
      assert.strictEqual(all[0]?.totals.outputTokens, 100_000);
      assert.strictEqual(all[1]?.totals.outputTokens, 40_000);
      assert.strictEqual(all[1]?.credits, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a missing sessions directory as no history rather than an error", () =>
    Effect.gen(function* () {
      const scans = yield* kiroUsageReader.scan({
        instances: [instance("kiro", "kiro-cli", "/nonexistent/kiro-home")],
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
