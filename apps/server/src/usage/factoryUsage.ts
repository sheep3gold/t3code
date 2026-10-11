/**
 * factoryUsage - token usage from Droid's per-session settings files.
 *
 * Droid's JSONL transcripts carry no per-message usage; the running totals
 * live in the sibling `<session>.settings.json` under `tokenUsage` (the
 * session's own calls; `inclusiveTokenUsage` folds in child sessions, which
 * have their own settings files and would be counted twice). Totals are
 * cumulative, so a session is attributed to its last write: a long session
 * that started before the window still counts in full.
 *
 * @module usage/factoryUsage
 */
import type { UsageTokenTotals } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export interface FactoryUsageRecord {
  readonly timestampMs: number;
  readonly model: string;
  readonly sessionId: string;
  readonly totals: UsageTokenTotals;
}

const SETTINGS_SUFFIX = ".settings.json";

const decodeJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>),
);

const count = (record: Record<string, unknown>, key: string): number => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
};

/** Parses one settings file; `null` when it carries no usage. */
export const decodeFactorySessionSettings = (
  text: string,
): Pick<FactoryUsageRecord, "model" | "totals"> | null => {
  const document = Option.getOrNull(decodeJson(text));
  if (typeof document !== "object" || document === null) return null;
  const settings = document as Record<string, unknown>;
  const usage = settings["tokenUsage"];
  if (typeof usage !== "object" || usage === null) return null;
  const tokens = usage as Record<string, unknown>;
  const outputTokens = count(tokens, "outputTokens");
  const routed = settings["effectiveFactoryRouterModel"];
  const routedModel =
    typeof routed === "object" && routed !== null
      ? (routed as { modelId?: unknown }).modelId
      : undefined;
  const model =
    typeof routedModel === "string" && routedModel.length > 0
      ? routedModel
      : typeof settings["model"] === "string" && settings["model"].length > 0
        ? settings["model"]
        : "factory";
  return {
    model,
    totals: {
      uncachedInputTokens: count(tokens, "inputTokens"),
      cachedInputTokens: count(tokens, "cacheReadTokens"),
      cacheCreationTokens: count(tokens, "cacheCreationTokens"),
      outputTokens,
      reasoningTokens: Math.min(outputTokens, count(tokens, "thinkingTokens")),
    },
  };
};

/**
 * Sessions under `sessionsRoot/<cwd-slug>/` last written at or after
 * `sinceMs`. A missing root yields `Option.none()`.
 */
export const readFactoryUsage = Effect.fn("factoryUsage.read")(function* (
  sessionsRoot: string,
  sinceMs: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* fileSystem
    .readDirectory(sessionsRoot)
    .pipe(Effect.catchCause(() => Effect.succeed(null)));
  if (projects === null) return Option.none<readonly FactoryUsageRecord[]>();

  const records: FactoryUsageRecord[] = [];
  for (const project of projects) {
    const directory = path.join(sessionsRoot, project);
    const entries = yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.catchCause(() => Effect.succeed([] as string[])));
    for (const entry of entries) {
      if (!entry.endsWith(SETTINGS_SUFFIX)) continue;
      const file = path.join(directory, entry);
      const mtimeMs = yield* fileSystem.stat(file).pipe(
        Effect.map((info) =>
          Option.getOrElse(
            Option.map(info.mtime, (d) => d.getTime()),
            () => 0,
          ),
        ),
        Effect.catchCause(() => Effect.succeed(0)),
      );
      if (mtimeMs < sinceMs) continue;
      const text = yield* fileSystem
        .readFileString(file)
        .pipe(Effect.catchCause(() => Effect.succeed("")));
      const decoded = decodeFactorySessionSettings(text);
      if (decoded === null) continue;
      records.push({
        ...decoded,
        timestampMs: mtimeMs,
        sessionId: entry.slice(0, -SETTINGS_SUFFIX.length),
      });
    }
  }
  return Option.some<readonly FactoryUsageRecord[]>(records);
});
