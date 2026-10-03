import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { decodeAntigravityGenMetadata, readAntigravityUsage } from "./antigravityUsage.ts";

const varint = (value: number): number[] => {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 128) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
};
const intField = (field: number, value: number) => [...varint(field * 8), ...varint(value)];
const bytesField = (field: number, bytes: number[]) => [
  ...varint(field * 8 + 2),
  ...varint(bytes.length),
  ...bytes,
];
const text = (value: string) => [...new TextEncoder().encode(value)];

/** Same nesting the agent writes: data.1 = generation, .4 usage, .9.4 start, .19 model. */
const genMetadata = (input: {
  seconds: number;
  model?: string;
  usage: Record<number, number>;
}): Uint8Array => {
  const usage = Object.entries(input.usage).flatMap(([field, value]) =>
    intField(Number(field), value),
  );
  const generation = [
    ...intField(3, 326),
    ...bytesField(4, usage),
    ...bytesField(9, [...intField(2, 2 ** 53 - 1), ...bytesField(4, intField(1, input.seconds))]),
    ...(input.model === undefined ? [] : bytesField(19, text(input.model))),
  ];
  return new Uint8Array([...bytesField(4, text("conversation")), ...bytesField(1, generation)]);
};

describe("antigravityUsage", () => {
  it("decodes ModelUsageStats into usage totals", () => {
    const decoded = decodeAntigravityGenMetadata(
      genMetadata({
        seconds: 1_791_046_459,
        model: "gemini-3.8-flash",
        usage: { 2: 5904, 3: 130, 5: 12193, 9: 54, 10: 76 },
      }),
    );
    assert.deepStrictEqual(decoded, {
      timestampMs: 1_791_046_459_000,
      model: "gemini-3.8-flash",
      totals: {
        uncachedInputTokens: 5904,
        cachedInputTokens: 12193,
        cacheCreationTokens: 0,
        outputTokens: 130,
        reasoningTokens: 54,
      },
    });
  });

  it("rejects blobs without usage", () => {
    assert.isNull(decodeAntigravityGenMetadata(new Uint8Array([0x0a, 0x02, 0x08, 0x01])));
    assert.isNull(decodeAntigravityGenMetadata(new Uint8Array([0xff, 0xff])));
  });

  it.live("reads in-window rows from conversation databases", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profile = yield* fileSystem.makeTempDirectoryScoped();
      const conversations = path.join(profile, "antigravity-acp", "conversations");
      yield* fileSystem.makeDirectory(conversations, { recursive: true });
      const database = new NodeSqlite.DatabaseSync(path.join(conversations, "c1.db"));
      database.exec("CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob)");
      const insert = database.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
      insert.run(0, genMetadata({ seconds: 1_000, model: "old", usage: { 2: 1, 3: 1 } }));
      insert.run(1, genMetadata({ seconds: 2_000, model: "gemini-x", usage: { 2: 10, 3: 5 } }));
      database.close();

      const records = yield* readAntigravityUsage(profile, 1_500_000);
      assert.isTrue(Option.isSome(records));
      const rows = Option.getOrThrow(records);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.model, "gemini-x");
      assert.strictEqual(rows[0]?.dedupeKey, "c1:1");

      const missing = yield* readAntigravityUsage(path.join(profile, "absent"), 0);
      assert.isTrue(Option.isNone(missing));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
