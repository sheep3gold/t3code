import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";

import type { AcpRegistrySettings } from "../settings.ts";

/**
 * The Kimi CLI session log records which tokens each response consumed but
 * never which model served it, so every record is attributed to the Kimi Code
 * plan the CLI talks to.
 */
export const KIMI_USAGE_MODEL = "kimi-code";

/**
 * The Kimi CLI writes its session log as `~/.kimi/sessions/<workspace>/<session>/wire.jsonl`.
 * `context.jsonl` sits next to it and repeats the same conversation without any
 * usage, so only the wire log is read.
 */
const KIMI_SESSION_FILE = "wire.jsonl";

/**
 * True when this ACP instance runs the Kimi CLI. The registry hosts several
 * agents and only the Kimi one keeps a session log T3 Code can attribute.
 */
export function isKimiCliCommand(commandPath: string): boolean {
  const trimmed = commandPath.trim();
  if (trimmed.length === 0) return false;
  const name = trimmed.split(/[\\/]/).pop() ?? "";
  const withoutExtension = name.replace(/\.(exe|cmd|bat)$/i, "");
  return withoutExtension === "kimi" || withoutExtension === "kimi-cli";
}

export function parseKimiLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parseKimiRecord(parsed);
}

function parseKimiRecord(parsed: unknown): UsageRecord | null {
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;
  if (messageRecord["type"] !== "StatusUpdate") return null;

  const payload = messageRecord["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const payloadRecord = payload as Record<string, unknown>;

  const usage = payloadRecord["token_usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  // The wire log timestamps in epoch seconds with a fractional part.
  const timestamp = record["timestamp"];
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  const timestampMs = Math.round(timestamp * 1000);

  const totals = {
    // `input_other` counts the tokens that were not served from the prompt
    // cache, so the three input buckets stay disjoint.
    uncachedInputTokens: tokenCount(usageRecord["input_other"]),
    cachedInputTokens: tokenCount(usageRecord["input_cache_read"]),
    cacheCreationTokens: tokenCount(usageRecord["input_cache_creation"]),
    outputTokens: tokenCount(usageRecord["output"]),
    // The Kimi CLI does not break thinking tokens out of its output count.
    reasoningTokens: 0,
  };
  if (totalTokens(totals) === 0) return null;

  // One status update per model response, each carrying that response's usage.
  // The message id identifies the response, so a replayed update is counted once.
  const messageId = payloadRecord["message_id"];

  return {
    provider: "kimi",
    timestampMs,
    model: KIMI_USAGE_MODEL,
    sessionId: "",
    totals,
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: typeof messageId === "string" && messageId.length > 0 ? `kimi:${messageId}` : null,
  };
}

const orEmpty = (record: UsageRecord | null): readonly UsageRecord[] =>
  record === null ? [] : [record];

export const kimiUsageFormat: TranscriptUsageFormat<void> = {
  selectFields: {
    timestamp: true,
    message: { type: true, payload: { token_usage: true, message_id: true } },
  },
  usageMarkers: ['"token_usage"'],
  parseLine: (line) => orEmpty(parseKimiLine(line)),
  parseProjected: (projected) => orEmpty(parseKimiRecord(projected)),
};

export const kimiUsageReader: ProviderUsageReader<AcpRegistrySettings, Path.Path> = {
  kind: "transcripts",
  provider: "kimi",
  format: kimiUsageFormat,
  directories: Effect.fn("kimiUsageReader.directories")(function* ({ config }) {
    if (config === undefined) return [];
    if (!isKimiCliCommand(config.commandPath)) return [];
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    return [
      {
        dir: path.resolve(path.join(homeDirectory, ".kimi"), "sessions"),
        fileName: KIMI_SESSION_FILE,
      },
    ];
  }),
};
