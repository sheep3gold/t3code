import type { ProviderInstanceId } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  type ProviderUsageReader,
  type ProviderUsageScan,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { AcpRegistrySettings } from "../settings.ts";

/**
 * Kiro CLI never reports per-request token counts: every `*_token_count` field
 * in its session files stays 0. What it does record per user turn is the
 * context occupancy (`final_context_usage_percentage`) against the model's
 * context window, plus the billed credits (`metering_usage`). Token totals are
 * therefore *estimates*: a turn's tokens are taken as the growth of the
 * context occupancy since the previous turn, or — when compaction shrank the
 * context — the post-turn occupancy itself as a lower bound.
 */
export const KIRO_USAGE_MODEL_FALLBACK = "kiro";

/** Sessions live at `<KIRO_HOME>/sessions/cli/<session>.json`; KIRO_HOME defaults to `~/.kiro`. */
const KIRO_SESSIONS_DIR = ["sessions", "cli"] as const;

export function isKiroCliCommand(commandPath: string): boolean {
  const name = commandPath.trim().split(/[\\/]/).pop() ?? "";
  return name.replace(/\.(exe|cmd|bat)$/i, "") === "kiro-cli";
}

interface KiroTurn {
  readonly end_timestamp?: unknown;
  readonly final_context_usage_percentage?: unknown;
  readonly context_usage_percentage?: unknown;
  readonly model?: unknown;
  readonly metering_usage?: unknown;
}

const asTurn = (value: unknown): KiroTurn | null =>
  typeof value === "object" && value !== null ? (value as KiroTurn) : null;

const asPercentage = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const creditValue = (entry: unknown): number => {
  if (typeof entry !== "object" || entry === null) return 0;
  const record = entry as Record<string, unknown>;
  if (record["unit"] !== "credit") return 0;
  const value = record["value"];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
};

const turnCredits = (turn: KiroTurn): number => {
  if (!Array.isArray(turn.metering_usage)) return 0;
  return turn.metering_usage.reduce((sum, entry) => sum + creditValue(entry), 0);
};

/**
 * Parses one session file into per-turn records. `context_window_tokens` comes
 * from the session-level model info; turns without a usable percentage or
 * timestamp are skipped (they carry no signal at all).
 */
export function parseKiroSession(sessionId: string, text: string): readonly UsageRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const root = parsed as Record<string, unknown>;
  const state = root["session_state"];
  if (typeof state !== "object" || state === null) return [];
  const stateRecord = state as Record<string, unknown>;

  const modelInfo = (stateRecord["rts_model_state"] as Record<string, unknown> | undefined)?.[
    "model_info"
  ] as Record<string, unknown> | undefined;
  const windowTokens =
    typeof modelInfo?.["context_window_tokens"] === "number" &&
    Number.isFinite(modelInfo["context_window_tokens"]) &&
    modelInfo["context_window_tokens"] > 0
      ? modelInfo["context_window_tokens"]
      : null;

  const metadata = stateRecord["conversation_metadata"];
  if (typeof metadata !== "object" || metadata === null) return [];
  const turns = (metadata as Record<string, unknown>)["user_turn_metadatas"];
  if (!Array.isArray(turns)) return [];

  const records: UsageRecord[] = [];
  let previousTokens: number | null = null;
  turns.forEach((raw, index) => {
    const turn = asTurn(raw);
    if (turn === null) return;
    const timestampMs = parseTimestampMs(turn.end_timestamp);
    if (timestampMs === null) return;
    const credits = turnCredits(turn);

    const percentage =
      asPercentage(turn.final_context_usage_percentage) ??
      asPercentage(turn.context_usage_percentage);
    let estimatedTokens = 0;
    if (percentage !== null && windowTokens !== null) {
      const contextTokens = (percentage / 100) * windowTokens;
      if (previousTokens === null) {
        // First observed turn: the whole context was built by this turn.
        estimatedTokens = contextTokens;
      } else if (contextTokens >= previousTokens) {
        estimatedTokens = contextTokens - previousTokens;
      } else {
        // Compaction dropped the occupancy; the post-turn context is the
        // lower bound of what this turn cost.
        estimatedTokens = contextTokens;
      }
      previousTokens = contextTokens;
    }

    if (estimatedTokens <= 0 && credits <= 0) return;
    const model =
      typeof turn.model === "string" && turn.model.length > 0
        ? turn.model
        : KIRO_USAGE_MODEL_FALLBACK;
    records.push({
      provider: "kiro",
      timestampMs,
      model,
      sessionId,
      totals: {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        // The estimate mixes input and output; it is reported as output so the
        // input buckets keep their exact meaning for providers that do know.
        outputTokens: Math.round(estimatedTokens),
        reasoningTokens: 0,
      },
      reportedCostUsd: null,
      credits: credits > 0 ? credits : null,
      speed: "standard",
      dedupeKey: `kiro:${sessionId}:${index}`,
    });
  });
  return records;
}

export const kiroUsageReader: Extract<
  ProviderUsageReader<AcpRegistrySettings, FileSystem.FileSystem | Path.Path>,
  { readonly kind: "scan" }
> = {
  kind: "scan",
  provider: "kiro",
  scan: Effect.fn("kiroUsageReader.scan")(function* ({ instances }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;

    // Instances sharing a KIRO_HOME share one session store and its attribution.
    const owners = new Map<string, ProviderInstanceId[]>();
    for (const instance of instances) {
      if (!instance.configured || instance.config === undefined) continue;
      if (!isKiroCliCommand(instance.config.commandPath)) continue;
      const configured = instance.environment["KIRO_HOME"]?.trim();
      const kiroHome = path.resolve(
        configured ? expandHomePath(configured, homeDirectory) : path.join(homeDirectory, ".kiro"),
      );
      owners.set(kiroHome, [...(owners.get(kiroHome) ?? []), instance.instanceId]);
    }

    return yield* Effect.forEach(
      owners,
      Effect.fnUntraced(function* ([home, instanceIds]) {
        const dir = path.join(home, ...KIRO_SESSIONS_DIR);
        const entries = yield* fileSystem.readDirectory(dir).pipe(
          Effect.map((names) => names.filter((name) => name.endsWith(".json")).sort()),
          Effect.orElseSucceed(() => null),
        );
        if (entries === null) {
          return { dir, files: null, instanceIds } satisfies ProviderUsageScan;
        }
        const files: { path: string; records: readonly UsageRecord[] }[] = [];
        let unread = 0;
        for (const name of entries) {
          const filePath = path.join(dir, name);
          const text = yield* fileSystem
            .readFileString(filePath)
            .pipe(Effect.orElseSucceed(() => null));
          if (text === null) {
            unread += 1;
            continue;
          }
          const sessionId = name.replace(/\.json$/, "");
          files.push({ path: filePath, records: parseKiroSession(sessionId, text) });
        }
        return {
          dir,
          files,
          instanceIds,
          ...(unread > 0
            ? {
                status: "partial" as const,
                message: `${unread} Kiro session file(s) could not be read; usage may be incomplete.`,
              }
            : {}),
        } satisfies ProviderUsageScan;
      }),
      { concurrency: "unbounded" },
    );
  }),
};
