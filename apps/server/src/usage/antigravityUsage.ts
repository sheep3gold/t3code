/**
 * antigravityUsage - token usage from the Antigravity agent's own
 * conversation databases.
 *
 * The agent writes one SQLite file per conversation under
 * `<profile>/antigravity-acp/conversations/*.db`; every model call appends a
 * `gen_metadata` row holding a protobuf whose field 1 carries the generation's
 * `ModelUsageStats` (field 4), its start timestamp (field 9.4) and the model
 * name (field 19). The descriptor ships in the agent binary:
 *
 * - 2 `input_tokens` (excludes cache reads), 3 `output_tokens`,
 *   4 `cache_write_tokens`, 5 `cache_read_tokens`,
 *   9 `thinking_output_tokens` (a subset of output).
 *
 * The databases are opened read-only so the live agent keeps sole write access.
 *
 * @module usage/antigravityUsage
 */
import * as NodeSqlite from "node:sqlite";

import type { UsageTokenTotals } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

export interface AntigravityUsageRecord {
  readonly timestampMs: number;
  readonly model: string;
  readonly totals: UsageTokenTotals;
  /** `<conversation>:<gen_metadata idx>`, unique per model call. */
  readonly dedupeKey: string;
}

type ProtoValue = number | Uint8Array;

/** Varints above 2^53 (e.g. sentinel `-1`s) lose precision; usage counts never get there. */
const readVarint = (bytes: Uint8Array, start: number): [number, number] | null => {
  let value = 0;
  let scale = 1;
  let index = start;
  while (index < bytes.length) {
    const byte = bytes[index]!;
    index += 1;
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return [value, index];
    scale *= 128;
    if (scale > 2 ** 70) return null;
  }
  return null;
};

/** First occurrence of each top-level field; `null` when the bytes are not a message. */
const readFields = (bytes: Uint8Array): Map<number, ProtoValue> | null => {
  const fields = new Map<number, ProtoValue>();
  let index = 0;
  while (index < bytes.length) {
    const key = readVarint(bytes, index);
    if (key === null) return null;
    index = key[1];
    const field = Math.floor(key[0] / 8);
    const wireType = key[0] % 8;
    let value: ProtoValue;
    if (wireType === 0) {
      const varint = readVarint(bytes, index);
      if (varint === null) return null;
      [value, index] = varint;
    } else if (wireType === 2) {
      const length = readVarint(bytes, index);
      if (length === null || length[1] + length[0] > bytes.length) return null;
      value = bytes.subarray(length[1], length[1] + length[0]);
      index = length[1] + length[0];
    } else if (wireType === 1) {
      value = bytes.subarray(index, index + 8);
      index += 8;
    } else if (wireType === 5) {
      value = bytes.subarray(index, index + 4);
      index += 4;
    } else {
      return null;
    }
    if (index > bytes.length) return null;
    if (!fields.has(field)) fields.set(field, value);
  }
  return fields;
};

const message = (fields: Map<number, ProtoValue> | null, field: number) => {
  const value = fields?.get(field);
  return value instanceof Uint8Array ? readFields(value) : null;
};

const count = (fields: Map<number, ProtoValue>, field: number): number => {
  const value = fields.get(field);
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
};

const textDecoder = new TextDecoder();

/** Decodes one `gen_metadata.data` blob; `null` when it carries no usage. */
export const decodeAntigravityGenMetadata = (
  data: Uint8Array,
): Omit<AntigravityUsageRecord, "dedupeKey"> | null => {
  const generation = message(readFields(data), 1);
  const usage = message(generation, 4);
  const startedAt = message(message(generation, 9), 4);
  if (generation === null || usage === null || startedAt === null) return null;
  const seconds = count(startedAt, 1);
  if (seconds === 0) return null;
  const modelBytes = generation.get(19);
  const outputTokens = count(usage, 3);
  return {
    timestampMs: seconds * 1000 + Math.floor(count(startedAt, 2) / 1e6),
    model: modelBytes instanceof Uint8Array ? textDecoder.decode(modelBytes) : "antigravity",
    totals: {
      uncachedInputTokens: count(usage, 2),
      cachedInputTokens: count(usage, 5),
      cacheCreationTokens: count(usage, 4),
      outputTokens,
      reasoningTokens: Math.min(outputTokens, count(usage, 9)),
    },
  };
};

const readDatabase = (file: string, conversationId: string, sinceMs: number) => {
  const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    const records: AntigravityUsageRecord[] = [];
    const rows = database.prepare("SELECT idx, data FROM gen_metadata").all();
    for (const row of rows) {
      const data = row["data"];
      if (!(data instanceof Uint8Array)) continue;
      const decoded = decodeAntigravityGenMetadata(data);
      if (decoded === null || decoded.timestampMs < sinceMs) continue;
      records.push({ ...decoded, dedupeKey: `${conversationId}:${String(row["idx"])}` });
    }
    return records;
  } finally {
    database.close();
  }
};

/**
 * Usage records at or after `sinceMs` from one Antigravity profile. A missing
 * profile yields `Option.none()`; an unreadable database is skipped.
 */
export const readAntigravityUsage = Effect.fn("antigravityUsage.read")(function* (
  profileDirectory: string,
  sinceMs: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(profileDirectory, "antigravity-acp", "conversations");
  const entries = yield* fileSystem
    .readDirectory(directory)
    .pipe(Effect.catchCause(() => Effect.succeed(null)));
  if (entries === null) return Option.none<readonly AntigravityUsageRecord[]>();

  const records: AntigravityUsageRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".db")) continue;
    const file = path.join(directory, entry);
    // The WAL sidecar takes the writes, so its mtime is the freshest signal.
    const mtimes = yield* Effect.forEach([file, `${file}-wal`], (candidate) =>
      fileSystem.stat(candidate).pipe(
        Effect.map((info) =>
          Option.getOrElse(
            Option.map(info.mtime, (d) => d.getTime()),
            () => 0,
          ),
        ),
        Effect.catchCause(() => Effect.succeed(0)),
      ),
    );
    if (Math.max(...mtimes) < sinceMs) continue;
    const parsed = yield* Effect.try(() =>
      readDatabase(file, entry.slice(0, -".db".length), sinceMs),
    ).pipe(Effect.catchCause(() => Effect.succeed([] as AntigravityUsageRecord[])));
    records.push(...parsed);
  }
  return Option.some<readonly AntigravityUsageRecord[]>(records);
});
