/**
 * gatewayUsage - attributes a gateway-routed Claude instance's usage to the
 * upstream providers the gateway actually called.
 *
 * A Claude instance can point its `ANTHROPIC_BASE_URL` at a local model
 * gateway (e.g. `http://127.0.0.1:4000`) that routes the `auto` model to other
 * providers. Its transcripts then record every call under the `auto` slug, so
 * the instance card shows one opaque row while the upstream providers' own
 * cards never see those tokens — the spend is real but invisible as anything
 * but `auto`.
 *
 * The gateway writes one L1 JSONL line per request with the routing decision:
 * `deployment` is `tier.provider.model` (e.g. `complex.workbuddy.kimi-k3-1`)
 * and `session_id` is the Claude session that made the call. Joining those
 * lines to the instance's in-window session ids splits the `auto` row into
 * per-upstream rows without double counting: the instance header total still
 * comes from its transcripts, and the upstream instance cards are untouched
 * because they never scanned these sessions.
 *
 * The L1 totals drift a few percent from the transcript totals (retries and
 * aborted streams bill at the gateway but leave no assistant record), so the
 * per-upstream rows are scaled to sum to the transcript-derived header total.
 *
 * @module usage/gatewayUsage
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { lookupRate, type RateTable } from "./usagePricing.ts";

/** Default on-disk layout of the model gateway (`/opt/model-gateway`). */
const DEFAULT_GATEWAY_DATA_DIR = "/opt/model-gateway/data/logs";

/** Token split for one upstream, before scaling to the transcript total. */
interface UpstreamTokens {
  inputTokens: number;
  outputTokens: number;
}

/** One upstream row for the instance card, after scaling to the transcript total. */
export interface GatewayUpstreamModel {
  /** `<provider> · <model>`, e.g. `workbuddy · kimi-k3-1`. */
  readonly model: string;
  readonly totalTokens: number;
  readonly costUsd: number;
}

const HomeSettings = Schema.Struct({
  env: Schema.optional(
    Schema.Struct({
      ANTHROPIC_BASE_URL: Schema.optional(Schema.String),
    }),
  ),
});
const decodeHomeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(HomeSettings));

/**
 * Whether `baseUrl` points at a gateway on this host. Only loopback URLs are
 * trusted: a remote URL gives no guarantee the local L1 logs describe its
 * routing, so the instance keeps its transcript rows instead.
 */
const isLocalGatewayBaseUrl = (baseUrl: string): boolean => {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
};

/**
 * Resolves the gateway L1 log directory for a Claude instance home, or
 * `Option.none()` when the instance is not gateway-backed.
 *
 * Detection reads the home's own `settings.json` (where the harness keeps
 * `env.ANTHROPIC_BASE_URL`), not the instance's environment: the base URL is a
 * property of the home directory the transcripts live under.
 */
export const resolveGatewayLogsDir = Effect.fn("gatewayUsage.resolveLogsDir")(function* (
  homePath: string,
  environment?: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = yield* fileSystem
    .readFileString(path.join(homePath, "settings.json"))
    .pipe(Effect.catchCause(() => Effect.succeed(null)));
  if (raw === null) return Option.none<string>();
  const decoded = decodeHomeSettings(raw);
  if (Option.isNone(decoded)) return Option.none<string>();
  const baseUrl = decoded.value.env?.ANTHROPIC_BASE_URL;
  if (baseUrl === undefined || !isLocalGatewayBaseUrl(baseUrl)) return Option.none<string>();
  const override = environment?.T3_GATEWAY_LOGS_DIR?.trim();
  return Option.some(override && override.length > 0 ? override : DEFAULT_GATEWAY_DATA_DIR);
});

/**
 * `complex.workbuddy.kimi-k3-1` → `{ provider: "workbuddy", model: "kimi-k3-1" }`.
 * The model itself can contain dots (`simple.glm.glm-5.3-flash`), so the split
 * anchors on the first two segments — tier and provider never do.
 */
const splitDeployment = (deployment: string): { provider: string; model: string } | null => {
  const first = deployment.indexOf(".");
  if (first <= 0) return null;
  const second = deployment.indexOf(".", first + 1);
  if (second <= first + 1) return null;
  const provider = deployment.slice(first + 1, second).trim();
  const model = deployment.slice(second + 1).trim();
  if (provider.length === 0 || model.length === 0) return null;
  return { provider, model };
};

const safeTokens = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** L1 lines are trusted but append-only; decode to `unknown` and narrow by hand. */
const decodeL1Line = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * Reads the gateway's L1 logs and folds the requests whose session id is in
 * `sessionIds` into per-upstream input/output token counts.
 *
 * Lines are parsed defensively: the file is append-only and the last line can
 * be mid-write, and shipped archives keep the same format. `cost` is unused —
 * rows are priced from the rate table under their real model name so the card
 * stays consistent with every other instance.
 */
export const readGatewayUpstreamTokens = Effect.fn("gatewayUsage.readUpstream")(function* (input: {
  readonly logsDir: string;
  readonly sessionIds: ReadonlySet<string>;
  readonly sinceMs: number;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (input.sessionIds.size === 0) return new Map<string, UpstreamTokens>();

  const listDir = (dir: string) =>
    fileSystem.readDirectory(dir).pipe(Effect.catchCause(() => Effect.succeed(null)));
  const live = yield* listDir(input.logsDir);
  if (live === null) return new Map<string, UpstreamTokens>();
  const shipped = yield* listDir(path.join(input.logsDir, "shipped"));

  const files: string[] = [];
  for (const name of live) {
    if (name.startsWith("l1-") && name.endsWith(".jsonl"))
      files.push(path.join(input.logsDir, name));
  }
  for (const name of shipped ?? []) {
    if (name.startsWith("l1-") && name.endsWith(".jsonl"))
      files.push(path.join(input.logsDir, "shipped", name));
  }
  files.sort();

  const byDeployment = new Map<string, UpstreamTokens>();
  for (const file of files) {
    // L1 files are named by UTC day, but shipped archives are not guaranteed
    // ordered, so records are filtered by timestamp rather than by file name.
    const raw = yield* fileSystem
      .readFileString(file)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (raw === null) continue;
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      const decoded = decodeL1Line(line);
      if (Option.isNone(decoded)) continue;
      const parsed: unknown = decoded.value;
      if (typeof parsed !== "object" || parsed === null) continue;
      const event = parsed as Record<string, unknown>;
      if (event["event"] !== "request" || event["status"] !== "success") continue;
      const sessionId = event["session_id"];
      if (typeof sessionId !== "string" || !input.sessionIds.has(sessionId)) continue;
      const ts = event["ts"];
      if (typeof ts === "string") {
        const tsMs = Date.parse(ts);
        if (Number.isFinite(tsMs) && tsMs < input.sinceMs) continue;
      }
      const inputTokens = safeTokens(event["prompt_tokens"]);
      const outputTokens = safeTokens(event["completion_tokens"]);
      if (inputTokens + outputTokens === 0) continue;
      const deployment = event["deployment"];
      if (typeof deployment !== "string") continue;
      const split = splitDeployment(deployment);
      if (split === null) continue;
      const key = `${split.provider} · ${split.model}`;
      const entry = byDeployment.get(key) ?? { inputTokens: 0, outputTokens: 0 };
      entry.inputTokens += inputTokens;
      entry.outputTokens += outputTokens;
      byDeployment.set(key, entry);
    }
  }
  return byDeployment;
});

/**
 * Splits a gateway-routed instance's transcript-derived total into
 * per-upstream rows.
 *
 * `upstreamTokens` comes from {@link readGatewayUpstreamTokens}; rows are
 * scaled so they sum to `transcriptTotalTokens` (the card header), which keeps
 * every token counted exactly once across the page. Rows are priced under
 * their real model name — the rate table knows `kimi-k3-1` even though it has
 * no rate for the `auto` slug — so the returned `costUsd` replaces the
 * header's (typically unpriced) `auto` cost with a priced estimate.
 *
 * Returns `null` when the split is impossible (no upstream data, or no
 * transcript total to anchor to); callers then keep the transcript rows.
 */
export const splitGatewayUsage = (input: {
  readonly transcriptTotalTokens: number;
  readonly upstreamTokens: ReadonlyMap<string, UpstreamTokens>;
  readonly rates: RateTable;
  readonly overrides?: RateTable;
}): { readonly models: readonly GatewayUpstreamModel[]; readonly costUsd: number } | null => {
  let upstreamTotal = 0;
  for (const tokens of input.upstreamTokens.values())
    upstreamTotal += tokens.inputTokens + tokens.outputTokens;
  if (upstreamTotal === 0 || input.transcriptTotalTokens <= 0) return null;

  const scale = input.transcriptTotalTokens / upstreamTotal;
  const models: GatewayUpstreamModel[] = [];
  let costUsd = 0;
  for (const [model, tokens] of input.upstreamTokens) {
    const scaledInput = tokens.inputTokens * scale;
    const scaledOutput = tokens.outputTokens * scale;
    const total = Math.max(0, Math.round(scaledInput + scaledOutput));
    if (total === 0) continue;
    // Price under the real model name: the rate table has `kimi-k3-1` even
    // though it has no rate for the `auto` slug the transcripts recorded.
    const bare = model.slice(model.indexOf("·") + 1).trim();
    const rate = input.overrides?.get(bare) ?? lookupRate(input.rates, bare);
    const cost =
      rate === null
        ? 0
        : scaledInput * rate.inputCostPerToken + scaledOutput * rate.outputCostPerToken;
    costUsd += cost;
    models.push({ model, totalTokens: total, costUsd: cost });
  }
  if (models.length === 0) return null;
  models.sort((a, b) => b.totalTokens - a.totalTokens);
  return { models, costUsd };
};
