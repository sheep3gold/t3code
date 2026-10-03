/**
 * usageQuotaProbe — per-request, short-cached quota reads for the provider
 * usage summary endpoint.
 *
 * Six probe kinds, each reading state the provider CLIs and hubs already
 * hold locally; nothing here invents a credential:
 *
 * - `glm`: Zhipu's `GET /api/monitor/usage/quota/limit`, authenticated with
 *   the `ANTHROPIC_AUTH_TOKEN` from the instance's Claude home settings.json.
 *   Reports the 5-hour concurrent lane and the weekly token quota.
 * - `claudeOAuth`: Anthropic's OAuth `GET /api/oauth/usage`, the same data
 *   `claude /usage` renders. The xjp account is geo-restricted to its
 *   Singapore exit, so the request always rides the local CONNECT proxy
 *   (127.0.0.1:2080) — never direct egress, never a VPN. The access token
 *   never leaves this process.
 * - `workbuddy`: the wb_proxy account files' cached credits
 *   (`~/.workbuddy2api-hub/accounts/*.json`). The panel API itself needs a
 *   password only ever stored hashed, so the probe reads the same files the
 *   proxy refreshes on its own schedule and reports the remaining points
 *   pool across accounts, flagging when the cache is more than a day old.
 * - `kimi`: Moonshot's `GET /v1/users/me/balance` (prepaid balance in CNY),
 *   authenticated with the key the instance's `apiKeyHelper` serves from etcd.
 * - `factory`: `GET api.factory.ai/api/organization/subscription/usage`, the
 *   data behind app.factory.ai/settings/usage, authenticated with the same
 *   etcd-held key the Droid provider spawns with and riding the same xjp
 *   proxy so every Factory egress leaves through the chosen node.
 * - `minimax`: `GET www.minimaxi.com/v1/api/openplatform/coding_plan/remains`,
 *   the endpoint `mcode` itself polls, authenticated with the API key the
 *   instance's `config.yaml` (`minimax_api.apiKey`) already holds. Reports
 *   the 5-hour window and the weekly window (`status 3` = unlimited).
 *
 * Results are cached briefly so the model-usage page's 30s polling does not
 * turn into upstream traffic on every refresh. Probe failures degrade to a
 * `probeFailed` row, never to a failed endpoint.
 *
 * @module usage/usageQuotaProbe
 */
import {
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type ServerSettings,
} from "@t3tools/contracts";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeFactoryApiKeyResolver } from "../provider/factoryApiKey.ts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

/** Instances refresh at most this often; the page polls every 30s, and
 * Anthropic's OAuth usage endpoint answers bursts with 429s. */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** A manual refresh bypasses the TTL but not a read this recent, so a
 * double-click (or several tabs) cannot hammer rate-limited upstreams. */
const REFRESH_FLOOR_MS = 5 * 1000;
const PROBE_TIMEOUT = "10 seconds";

const CLAUDE_SETTINGS_FILE = "settings.json";
const CLAUDE_CREDENTIALS_FILE = ".credentials.json";
const WORKBUDDY_ACCOUNTS_DIR = "/home/ubuntu/.workbuddy2api-hub/accounts";
/** Credits older than this are labelled stale rather than silently served. */
const WORKBUDDY_CREDITS_STALE_MS = 24 * 60 * 60 * 1000;
const GLM_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
const KIMI_BALANCE_URL = "https://api.moonshot.cn/v1/users/me/balance";
const MINIMAX_REMAINS_URL = "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains";
const MINIMAX_CONFIG_FILE = "config.yaml";
const ANTHROPIC_OAUTH_USAGE_PATH = "/api/oauth/usage";
/** Local CONNECT exit the xjp CLI rides (see /usr/local/bin/claude-xjp). */
const XJP_PROXY_HOST = "127.0.0.1";
const XJP_PROXY_PORT = 2080;

export class UsageQuotaProbeError extends Data.TaggedError("UsageQuotaProbeError")<{
  readonly probe: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

const probeError = (probe: string) => (cause: unknown) =>
  new UsageQuotaProbeError({
    probe,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const encodeJsonBody = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>),
);
const decodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>),
);

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

const getJson = (
  client: HttpClient.HttpClient,
  probe: string,
  request: HttpClientRequest.HttpClientRequest,
) =>
  client.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.flatMap(decodeJson),
    Effect.timeout(PROBE_TIMEOUT),
    Effect.mapError(probeError(probe)),
  );

/** Reads one HTTPS JSON document through the local xjp CONNECT proxy. */
const getJsonViaXjp = (
  probe: string,
  hostname: string,
  path: string,
  accessToken: string,
  headers: Readonly<Record<string, string>> = {},
): Effect.Effect<unknown, UsageQuotaProbeError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<unknown>((resolve, reject) => {
        const fail = (error: Error) => reject(error);
        const proxySocket = NodeNet.connect(XJP_PROXY_PORT, XJP_PROXY_HOST);
        proxySocket.setTimeout(10_000, () => {
          proxySocket.destroy();
          fail(new Error("xjp proxy connect timed out"));
        });
        proxySocket.once("error", () =>
          fail(new Error(`xjp proxy (${XJP_PROXY_HOST}:${XJP_PROXY_PORT}) is not reachable`)),
        );
        proxySocket.once("connect", () => {
          proxySocket.write(
            `CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\n` +
              `User-Agent: Node\r\n\r\n`,
          );
          let handshake = "";
          const onHandshakeData = (chunk: Buffer) => {
            handshake += chunk.toString("latin1");
            const headerEnd = handshake.indexOf("\r\n\r\n");
            if (headerEnd === -1) return;
            proxySocket.off("data", onHandshakeData);
            proxySocket.setTimeout(0);
            const statusLine = handshake.slice(0, handshake.indexOf("\r\n"));
            if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
              proxySocket.destroy();
              fail(new Error(`xjp proxy CONNECT failed: ${statusLine}`));
              return;
            }
            const tlsSocket = NodeTls.connect({
              socket: proxySocket,
              servername: hostname,
              ALPNProtocols: ["http/1.1"],
            });
            tlsSocket.setTimeout(10_000, () => {
              tlsSocket.destroy();
              fail(new Error(`${probe} read timed out`));
            });
            tlsSocket.once("secureConnect", () => {
              tlsSocket.write(
                `GET ${path} HTTP/1.1\r\n` +
                  `Host: ${hostname}\r\n` +
                  `Authorization: Bearer ${accessToken}\r\n` +
                  `Accept: application/json\r\n` +
                  Object.entries(headers)
                    .map(([name, value]) => `${name}: ${value}\r\n`)
                    .join("") +
                  `Connection: close\r\n\r\n`,
              );
              let raw = "";
              tlsSocket.on("data", (chunk: Buffer) => {
                raw += chunk.toString("latin1");
              });
              tlsSocket.once("error", (error) => {
                if (raw.length > 0) {
                  const bodyStart = raw.indexOf("\r\n\r\n");
                  const headers = raw.slice(0, bodyStart);
                  let body = raw.slice(bodyStart + 4);
                  if (bodyStart !== -1 && /transfer-encoding:\s*chunked/i.test(headers)) {
                    body = body
                      .split("\r\n")
                      .filter((line) => !/^[0-9a-fA-F]+$/.test(line) && line.length > 0)
                      .join("");
                  }
                  if (bodyStart !== -1) {
                    resolve(JSON.parse(body) as unknown);
                    return;
                  }
                  tlsSocket.destroy();
                  return;
                }
                fail(error);
              });
              tlsSocket.once("close", () => {
                const bodyStart = raw.indexOf("\r\n\r\n");
                const statusLine = raw.slice(0, raw.indexOf("\r\n"));
                if (bodyStart === -1) {
                  fail(new Error(`${probe} response was empty`));
                  return;
                }
                if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
                  fail(new Error(`${probe} returned ${statusLine}`));
                  return;
                }
                let body = raw.slice(bodyStart + 4);
                if (/transfer-encoding:\s*chunked/i.test(raw.slice(0, bodyStart))) {
                  body = body
                    .split("\r\n")
                    .filter((line) => !/^[0-9a-fA-F]+$/.test(line) && line.length > 0)
                    .join("");
                }
                try {
                  resolve(JSON.parse(body) as unknown);
                } catch {
                  fail(new Error(`${probe} response was not JSON`));
                }
              });
            });
          };
          proxySocket.on("data", onHandshakeData);
        });
      }),
    catch: probeError(probe),
  });

const windowUnavailable = (checkedAt: string, message: string): ServerProviderUsageLimits => ({
  checkedAt,
  windows: [],
  unavailable: { reason: "probeFailed", message: message.slice(0, 200) as never },
});

const isoFromEpochMs = (epochMs: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(epochMs));

/* ------------------------------------------------------------------ */
/* GLM (Zhipu BigModel anthropic-compatible subscription)              */
/* ------------------------------------------------------------------ */

interface GlmLimit {
  readonly type?: string;
  readonly unit?: number;
  readonly number?: number;
  readonly percentage?: number;
  readonly nextResetTime?: number;
}

const glmProbe = (
  client: HttpClient.HttpClient,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
): Effect.Effect<ServerProviderUsageLimits, UsageQuotaProbeError> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const settingsText = yield* fileSystem
      .readFileString(path.join(home, CLAUDE_SETTINGS_FILE))
      .pipe(Effect.mapError(probeError("glm")));
    const settings = yield* decodeJson(settingsText).pipe(Effect.mapError(probeError("glm")));
    const record =
      typeof settings === "object" && settings !== null
        ? (settings as { apiKeyHelper?: unknown; env?: Record<string, unknown> })
        : {};
    // `apiKeyHelper` is `<script> <etcd-key-path>`; the path is the argument.
    const helperArg =
      typeof record.apiKeyHelper === "string"
        ? record.apiKeyHelper
            .trim()
            .split(/\s+/)
            .findLast((part) => part.startsWith("/"))
        : undefined;
    const staticKey =
      typeof record.env?.ANTHROPIC_AUTH_TOKEN === "string"
        ? record.env.ANTHROPIC_AUTH_TOKEN
        : undefined;
    const token = yield* resolveEtcdKey(
      helperArg !== undefined && helperArg.includes("appkey") ? helperArg : undefined,
      staticKey,
    );
    if (token.length === 0) {
      return windowUnavailable(checkedAt, "glm 缺少可用的 API key");
    }

    const document = yield* getJson(
      client,
      "glm",
      HttpClientRequest.get(GLM_QUOTA_URL).pipe(
        HttpClientRequest.setHeader("Authorization", token),
        HttpClientRequest.acceptJson,
      ),
    );
    const limits =
      typeof document === "object" && document !== null
        ? ((document as { data?: { limits?: GlmLimit[] } }).data?.limits ?? [])
        : [];

    const windows: ServerProviderUsageWindow[] = [];
    for (const limit of limits) {
      if (typeof limit.percentage !== "number") continue;
      const base = {
        usedPercent: Math.max(0, Math.min(100, limit.percentage)),
        ...(typeof limit.nextResetTime === "number"
          ? { resetsAt: isoFromEpochMs(limit.nextResetTime) }
          : {}),
      } as const;
      // unit 3 = 5-hour MCP concurrent lane; unit 6 = weekly token quota.
      if (limit.unit === 3) {
        windows.push({
          id: "five_hour",
          kind: "session",
          label: `5 小时并发（${limit.number ?? "?"} 路）`,
          windowDurationMins: 300,
          ...base,
        });
      } else if (limit.unit === 6) {
        windows.push({
          id: "weekly_tokens",
          kind: "weekly",
          label: "周 token 配额",
          windowDurationMins: 7 * 24 * 60,
          ...base,
        });
      } else {
        windows.push({
          id: `unit_${limit.unit ?? "other"}`,
          kind: "other",
          label: `配额窗口（unit ${limit.unit ?? "?"}）`,
          ...base,
        });
      }
    }
    if (windows.length === 0) return windowUnavailable(checkedAt, "GLM 配额接口未返回窗口");
    return { checkedAt, windows } satisfies ServerProviderUsageLimits;
  });

/* ------------------------------------------------------------------ */
/* Claude OAuth (Pro/Max subscription, `claude /usage`)                 */
/* ------------------------------------------------------------------ */

interface ClaudeOauthUsageWindow {
  readonly utilization?: number | null;
  readonly resets_at?: string | null;
}

const CLAUDE_WINDOW_LABELS: ReadonlyArray<{
  readonly key: string;
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
}> = [
  { key: "five_hour", id: "five_hour", kind: "session", label: "5 小时窗口" },
  { key: "seven_day", id: "seven_day", kind: "weekly", label: "7 天窗口" },
  { key: "seven_day_opus", id: "seven_day_opus", kind: "weekly", label: "7 天（Opus）" },
  { key: "seven_day_sonnet", id: "seven_day_sonnet", kind: "weekly", label: "7 天（Sonnet）" },
];

/**
 * Reads `/api/oauth/usage` through the local CONNECT proxy the xjp CLI rides.
 * The account is geo-restricted: a direct request from this host's egress is
 * both against the account's usage rules and indistinguishable from a leak,
 * so there is deliberately no direct-egress fallback here — when the proxy is
 * down the probe fails and the page shows 探测失败.
 *
 * The handshake is done by hand because the shared `HttpClient` has no proxy
 * support: CONNECT to 127.0.0.1:2080, upgrade the tunnel to TLS with the real
 * SNI, then a plain HTTP/1.1 GET. Body reads assume a single response with a
 * Content-Length, which holds for this small JSON document.
 */
const readAnthropicUsageViaXjp = (
  accessToken: string,
): Effect.Effect<unknown, UsageQuotaProbeError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<unknown>((resolve, reject) => {
        const fail = (error: Error) => reject(error);
        const proxySocket = NodeNet.connect(XJP_PROXY_PORT, XJP_PROXY_HOST);
        proxySocket.setTimeout(10_000, () => {
          proxySocket.destroy();
          fail(new Error("xjp proxy connect timed out"));
        });
        proxySocket.once("error", () =>
          fail(new Error("xjp proxy (127.0.0.1:2080) is not reachable")),
        );
        proxySocket.once("connect", () => {
          proxySocket.write(
            `CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n`,
          );
          let handshake = "";
          const onHandshakeData = (chunk: Buffer) => {
            handshake += chunk.toString("latin1");
            const headerEnd = handshake.indexOf("\r\n\r\n");
            if (headerEnd === -1) return;
            proxySocket.off("data", onHandshakeData);
            const statusLine = handshake.slice(0, handshake.indexOf("\r\n"));
            if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
              proxySocket.destroy();
              fail(new Error(`xjp proxy CONNECT failed: ${statusLine}`));
              return;
            }
            const tlsSocket = NodeTls.connect({
              socket: proxySocket,
              servername: "api.anthropic.com",
            });
            tlsSocket.setTimeout(10_000, () => {
              tlsSocket.destroy();
              fail(new Error("anthropic usage read timed out"));
            });
            tlsSocket.once("error", fail);
            tlsSocket.once("secureConnect", () => {
              tlsSocket.write(
                `GET ${ANTHROPIC_OAUTH_USAGE_PATH} HTTP/1.1\r\n` +
                  `Host: api.anthropic.com\r\n` +
                  `Authorization: Bearer ${accessToken}\r\n` +
                  `anthropic-beta: oauth-2025-04-20\r\n` +
                  `User-Agent: claude-cli/2.0.37 (external, cli)\r\n` +
                  `Accept: application/json\r\n` +
                  `Connection: close\r\n\r\n`,
              );
              let raw = "";
              tlsSocket.on("data", (chunk: Buffer) => {
                raw += chunk.toString("latin1");
              });
              tlsSocket.once("close", () => {
                const bodyStart = raw.indexOf("\r\n\r\n");
                const statusLine = raw.slice(0, raw.indexOf("\r\n"));
                if (bodyStart === -1) {
                  fail(new Error("anthropic usage response was empty"));
                  return;
                }
                if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
                  fail(new Error(`anthropic usage returned ${statusLine}`));
                  return;
                }
                let body = raw.slice(bodyStart + 4);
                if (/transfer-encoding:\s*chunked/i.test(raw.slice(0, bodyStart))) {
                  // Chunk frames are hex-length CRLF payload; the trailer ends
                  // with a zero-length chunk. JSON never carries bare CRLF at
                  // frame boundaries, so dropping size lines is safe here.
                  body = body
                    .split("\r\n")
                    .filter((line) => !/^[0-9a-fA-F]+$/.test(line) && line.length > 0)
                    .join("");
                }
                try {
                  resolve(JSON.parse(body) as unknown);
                } catch {
                  fail(new Error("anthropic usage response was not JSON"));
                }
              });
            });
          };
          proxySocket.on("data", onHandshakeData);
        });
      }),
    catch: probeError("claudeOAuth"),
  });

const claudeOauthProbe = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
): Effect.Effect<ServerProviderUsageLimits, UsageQuotaProbeError> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const credentialsText = yield* fileSystem
      .readFileString(path.join(home, CLAUDE_CREDENTIALS_FILE))
      .pipe(Effect.mapError(probeError("claudeOAuth")));
    const credentials = yield* decodeJson(credentialsText).pipe(
      Effect.mapError(probeError("claudeOAuth")),
    );
    const accessToken =
      typeof credentials === "object" && credentials !== null
        ? ((credentials as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth
            ?.accessToken ?? null)
        : null;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      return windowUnavailable(checkedAt, "OAuth 凭证为空，需要重新 claude auth login");
    }

    const document = yield* readAnthropicUsageViaXjp(accessToken);

    const windows: ServerProviderUsageWindow[] = [];
    if (typeof document === "object" && document !== null) {
      const usage = document as Record<string, ClaudeOauthUsageWindow | null | undefined>;
      for (const spec of CLAUDE_WINDOW_LABELS) {
        const window = usage[spec.key];
        if (window == null || typeof window.utilization !== "number") continue;
        windows.push({
          id: spec.id,
          kind: spec.kind,
          label: spec.label,
          usedPercent: Math.max(0, Math.min(100, window.utilization)),
          ...(typeof window.resets_at === "string" ? { resetsAt: window.resets_at } : {}),
        });
      }
    }
    if (windows.length === 0) return windowUnavailable(checkedAt, "Anthropic 未返回用量窗口");
    return { checkedAt, windows } satisfies ServerProviderUsageLimits;
  });

/* ------------------------------------------------------------------ */
/* WorkBuddy hub (wb_proxy points pool)                                 */
/* ------------------------------------------------------------------ */

const workbuddyProbe = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<ServerProviderUsageLimits, UsageQuotaProbeError> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const entries = yield* fileSystem
      .readDirectory(WORKBUDDY_ACCOUNTS_DIR)
      .pipe(Effect.mapError(probeError("workbuddy")));
    const nowMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

    let remaining = 0;
    let reported = 0;
    let stale = 0;
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry === "settings.json" || entry === "active_realm.json")
        continue;
      const text = yield* fileSystem
        .readFileString(path.join(WORKBUDDY_ACCOUNTS_DIR, entry))
        .pipe(Effect.orElseSucceed(() => ""));
      if (text.length === 0) continue;
      const document = yield* decodeJson(text).pipe(Effect.orElseSucceed(() => null));
      if (typeof document !== "object" || document === null) continue;
      const credits = (document as { credits?: { remain?: unknown; updated_at?: unknown } })
        .credits;
      const remain = credits?.remain;
      if (typeof remain !== "number") continue;
      remaining += remain;
      reported += 1;
      if (
        typeof credits?.updated_at !== "number" ||
        nowMs - credits.updated_at * 1000 > WORKBUDDY_CREDITS_STALE_MS
      ) {
        stale += 1;
      }
    }
    if (reported === 0) return windowUnavailable(checkedAt, "wb_proxy 账号目录没有积分缓存");

    return {
      checkedAt,
      windows: [
        {
          id: "points_pool",
          kind: "monthly",
          label:
            stale > 0
              ? `剩余积分（${reported} 账号，${stale} 个缓存超 24h）`
              : `剩余积分（${reported} 账号）`,
          usedPercent: 0,
          remaining: Math.round(remaining),
          remainingUnit: "积分",
        },
      ],
    } satisfies ServerProviderUsageLimits;
  });

/* ------------------------------------------------------------------ */
/* Etcd-held keys (Kimi, Factory)                                       */
/* ------------------------------------------------------------------ */

/** Current value of an etcd-held key, falling back to `fallback` when etcd
 * is unreachable or holds nothing. Reuses the Droid provider's resolver so
 * the bootstrap credential and caching behave identically. */
const resolveEtcdKey = (etcdKey: string | undefined, fallback: string | undefined) =>
  makeFactoryApiKeyResolver({
    etcdKey,
    baseEnvironment: fallback ? { FACTORY_API_KEY: fallback } : {},
  }).environment.pipe(Effect.map((environment) => environment.FACTORY_API_KEY?.trim() ?? ""));

const formatCompactCount = (value: number): string =>
  value >= 1e8
    ? `${(value / 1e8).toFixed(1)} 亿`
    : value >= 1e4
      ? `${(value / 1e4).toFixed(0)} 万`
      : String(Math.round(value));

/* ------------------------------------------------------------------ */
/* Kimi (Moonshot prepaid balance)                                      */
/* ------------------------------------------------------------------ */

const kimiProbe = (
  client: HttpClient.HttpClient,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
): Effect.Effect<ServerProviderUsageLimits, UsageQuotaProbeError> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const settingsText = yield* fileSystem
      .readFileString(path.join(home, CLAUDE_SETTINGS_FILE))
      .pipe(Effect.mapError(probeError("kimi")));
    const settings = yield* decodeJson(settingsText).pipe(Effect.mapError(probeError("kimi")));
    const record =
      typeof settings === "object" && settings !== null
        ? (settings as { apiKeyHelper?: unknown; env?: Record<string, unknown> })
        : {};
    // `apiKeyHelper` is `<script> <etcd-key-path>`; the path is the argument.
    const helperArg =
      typeof record.apiKeyHelper === "string"
        ? record.apiKeyHelper
            .trim()
            .split(/\s+/)
            .findLast((part) => part.startsWith("/"))
        : undefined;
    const staticKey =
      typeof record.env?.ANTHROPIC_AUTH_TOKEN === "string"
        ? record.env.ANTHROPIC_AUTH_TOKEN
        : typeof record.env?.ANTHROPIC_API_KEY === "string"
          ? record.env.ANTHROPIC_API_KEY
          : undefined;
    const key = yield* resolveEtcdKey(
      helperArg !== undefined && helperArg.includes("appkey") ? helperArg : undefined,
      staticKey,
    );
    if (key.length === 0) return windowUnavailable(checkedAt, "kimi 缺少可用的 API key");

    const document = yield* getJson(
      client,
      "kimi",
      HttpClientRequest.get(KIMI_BALANCE_URL).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${key}`),
        HttpClientRequest.acceptJson,
      ),
    );
    const data =
      typeof document === "object" && document !== null
        ? (
            document as {
              data?: {
                available_balance?: unknown;
                cash_balance?: unknown;
                voucher_balance?: unknown;
              };
            }
          ).data
        : undefined;
    const available = data?.available_balance;
    if (typeof available !== "number")
      return windowUnavailable(checkedAt, "Kimi 余额接口未返回余额");

    const parts: string[] = [];
    if (typeof data?.cash_balance === "number") parts.push(`现金 ${data.cash_balance.toFixed(2)}`);
    if (typeof data?.voucher_balance === "number") {
      parts.push(`代金券 ${data.voucher_balance.toFixed(2)}`);
    }
    return {
      checkedAt,
      windows: [
        {
          id: "balance",
          kind: "other",
          label: parts.length > 0 ? `账户余额（${parts.join(" + ")}）` : "账户余额",
          usedPercent: 0,
          remaining: Math.max(0, Math.round(available * 100) / 100),
          remainingUnit: "元",
        },
      ],
    } satisfies ServerProviderUsageLimits;
  });

/* ------------------------------------------------------------------ */
/* Factory (Droid subscription token allowance)                         */
/* ------------------------------------------------------------------ */

interface FactoryBillingWindow {
  readonly usedPercent?: number;
  readonly windowEnd?: string | null;
  readonly secondsRemaining?: number | null;
}

interface FactoryBillingTier {
  readonly fiveHour?: FactoryBillingWindow;
  readonly weekly?: FactoryBillingWindow;
  readonly monthly?: FactoryBillingWindow;
}

const factoryProbe = (
  etcdKey: string | undefined,
): Effect.Effect<ServerProviderUsageLimits, UsageQuotaProbeError> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const key = yield* resolveEtcdKey(etcdKey, process.env.FACTORY_API_KEY);
    if (key.length === 0) return windowUnavailable(checkedAt, "factory 缺少可用的 API key");

    const document = yield* getJsonViaXjp("factory", "api.factory.ai", "/api/billing/limits", key, {
      "User-Agent": "droid/0.233.0",
    });
    const limits =
      typeof document === "object" && document !== null
        ? (
            document as {
              limits?: { standard?: FactoryBillingTier; core?: FactoryBillingTier };
            }
          ).limits
        : undefined;

    const windows: ServerProviderUsageWindow[] = [];
    const tiers = [
      ["standard", "标准", limits?.standard],
      ["core", "Droid Core", limits?.core],
    ] as const;
    const windowDefs = [
      ["fiveHour", "5 小时", "session", 300] as const,
      ["weekly", "周", "weekly", 7 * 24 * 60] as const,
      ["monthly", "月", "monthly", 30 * 24 * 60] as const,
    ] as const;
    for (const [tierId, tierName, tier] of tiers) {
      if (tier === undefined) continue;
      for (const [winKey, winLabel, kind, durationMins] of windowDefs) {
        const win = tier[winKey];
        if (win === undefined || typeof win.usedPercent !== "number") continue;
        if (win.usedPercent === 0 && win.windowEnd == null) continue;
        windows.push({
          id: `${tierId}_${winKey}`,
          kind,
          label: `${tierName} ${winLabel}用量`,
          windowDurationMins: durationMins,
          usedPercent: Math.max(0, Math.min(100, win.usedPercent)),
          ...(typeof win.windowEnd === "string" ? { resetsAt: win.windowEnd } : {}),
        });
      }
    }
    if (windows.length === 0) return windowUnavailable(checkedAt, "Factory 用量接口未返回额度");
    return { checkedAt, windows } satisfies ServerProviderUsageLimits;
  });

/* ------------------------------------------------------------------ */
/* MiniMax (Token Plan windows, same endpoint `mcode` polls)            */
/* ------------------------------------------------------------------ */

interface MinimaxModelRemain {
  readonly model_name?: string;
  readonly end_time?: number;
  readonly weekly_end_time?: number;
  readonly current_interval_status?: number;
  readonly current_interval_remaining_percent?: number;
  readonly current_weekly_status?: number;
  readonly current_weekly_remaining_percent?: number;
}

/** `minimax_api.apiKey` from mcode's config.yaml, without a YAML parser. */
const minimaxApiKey = (configText: string): string =>
  /^minimax_api:[ \t]*\r?\n[ \t]+apiKey:[ \t]*["']?([^\s"']+)/m.exec(configText)?.[1] ?? "";

const minimaxProbe = (
  client: HttpClient.HttpClient,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  dataDir: string,
): Effect.Effect<ServerProviderUsageLimits, UsageQuotaProbeError> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const configText = yield* fileSystem
      .readFileString(path.join(dataDir, MINIMAX_CONFIG_FILE))
      .pipe(Effect.mapError(probeError("minimax")));
    const key = minimaxApiKey(configText);
    if (key.length === 0) return windowUnavailable(checkedAt, "minimax 缺少可用的 API key");

    const document = yield* getJson(
      client,
      "minimax",
      HttpClientRequest.get(MINIMAX_REMAINS_URL).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${key}`),
        HttpClientRequest.acceptJson,
      ),
    );
    const body =
      typeof document === "object" && document !== null
        ? (document as {
            base_resp?: { status_code?: number; status_msg?: string };
            model_remains?: MinimaxModelRemain[];
          })
        : {};
    if (typeof body.base_resp?.status_code === "number" && body.base_resp.status_code !== 0) {
      return windowUnavailable(
        checkedAt,
        `MiniMax 额度接口：${body.base_resp.status_msg ?? "失败"}`,
      );
    }
    // The first entry is the text-model pool; video has its own count quota.
    const general = body.model_remains?.[0];
    if (general === undefined) return windowUnavailable(checkedAt, "MiniMax 额度接口未返回窗口");

    const windows: ServerProviderUsageWindow[] = [];
    const push = (
      id: string,
      kind: "session" | "weekly",
      name: string,
      durationMins: number,
      status: number | undefined,
      remainingPercent: number | undefined,
      endMs: number | undefined,
    ) => {
      const unlimited = status === 3;
      if (!unlimited && remainingPercent === undefined) return;
      windows.push({
        id,
        kind,
        label: unlimited ? `${name}（无限制）` : name,
        windowDurationMins: durationMins,
        usedPercent: unlimited ? 0 : Math.max(0, Math.min(100, 100 - (remainingPercent ?? 100))),
        ...(!unlimited && typeof endMs === "number" && endMs > 0
          ? { resetsAt: isoFromEpochMs(endMs) }
          : {}),
      });
    };
    push(
      "five_hour",
      "session",
      "5 小时额度",
      300,
      general.current_interval_status,
      general.current_interval_remaining_percent,
      general.end_time,
    );
    push(
      "weekly",
      "weekly",
      "周额度",
      7 * 24 * 60,
      general.current_weekly_status,
      general.current_weekly_remaining_percent,
      general.weekly_end_time,
    );
    if (windows.length === 0) return windowUnavailable(checkedAt, "MiniMax 额度接口未返回窗口");
    return { checkedAt, windows } satisfies ServerProviderUsageLimits;
  });

/* ------------------------------------------------------------------ */
/* Instance wiring + cache                                              */
/* ------------------------------------------------------------------ */

type ProbeKind = "glm" | "claudeOAuth" | "workbuddy" | "kimi" | "factory" | "minimax";

const HOME_ENV_BY_DRIVER: Record<string, string> = {
  claudeAgent: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

const instanceHome = (settings: ServerSettings, instanceKey: string): string | null => {
  const instance = settings.providerInstances[instanceKey as never];
  if (instance === undefined) return null;
  const config = (instance.config ?? {}) as { homePath?: unknown };
  if (typeof config.homePath === "string" && config.homePath.trim().length > 0) {
    return config.homePath.trim();
  }
  const envName = HOME_ENV_BY_DRIVER[instance.driver];
  if (envName !== undefined) {
    for (const entry of instance.environment ?? []) {
      if (entry.name === envName && typeof entry.value === "string" && entry.value.length > 0) {
        return entry.value;
      }
    }
  }
  return null;
};

const probeForInstance = (
  settings: ServerSettings,
  instanceKey: string,
): {
  readonly kind: ProbeKind;
  readonly home: string | null;
  readonly etcdKey?: string;
} | null => {
  if (instanceKey === "claude_glm")
    return { kind: "glm", home: instanceHome(settings, instanceKey) };
  if (instanceKey === "claude_xjp") {
    return { kind: "claudeOAuth", home: instanceHome(settings, instanceKey) };
  }
  if (instanceKey === "codex_workbuddy") return { kind: "workbuddy", home: null };
  if (instanceKey === "claude_kimi")
    return { kind: "kimi", home: instanceHome(settings, instanceKey) };
  const instance = settings.providerInstances[instanceKey as never];
  if (instance?.driver === "minimax") {
    const dataDir = ((instance.config ?? {}) as { dataDir?: unknown }).dataDir;
    return {
      kind: "minimax",
      home: typeof dataDir === "string" && dataDir.trim().length > 0 ? dataDir.trim() : null,
    };
  }
  if (instance?.driver === "factory") {
    const etcdKey = ((instance.config ?? {}) as { apiKeyEtcdKey?: unknown }).apiKeyEtcdKey;
    return {
      kind: "factory",
      home: null,
      ...(typeof etcdKey === "string" ? { etcdKey } : {}),
    };
  }
  return null;
};

const cache = new Map<string, { atMs: number; limits: ServerProviderUsageLimits }>();

/**
 * Reads one instance's quota windows, cached for {@link CACHE_TTL_MS};
 * `refresh` shortens that to {@link REFRESH_FLOOR_MS}.
 * Instances without a probe resolve to `undefined`, letting the endpoint
 * fall back to its existing unavailable row.
 */
export const readInstanceUsageLimits = Effect.fn("usageQuotaProbe.readInstanceUsageLimits")(
  function* (
    settings: ServerSettings,
    instanceKey: string,
    options?: { readonly refresh?: boolean },
  ) {
    const probe = probeForInstance(settings, instanceKey);
    if (probe === null) return undefined;

    const cached = cache.get(instanceKey);
    const nowMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
    const maxAgeMs = options?.refresh === true ? REFRESH_FLOOR_MS : CACHE_TTL_MS;
    if (cached !== undefined && nowMs - cached.atMs < maxAgeMs) {
      return cached.limits;
    }

    const client = yield* HttpClient.HttpClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const run: Effect.Effect<ServerProviderUsageLimits, UsageQuotaProbeError> =
      probe.kind === "glm" && probe.home !== null
        ? glmProbe(client, fileSystem, path, probe.home)
        : probe.kind === "claudeOAuth" && probe.home !== null
          ? claudeOauthProbe(fileSystem, path, probe.home)
          : probe.kind === "workbuddy"
            ? workbuddyProbe(fileSystem, path)
            : probe.kind === "kimi" && probe.home !== null
              ? kimiProbe(client, fileSystem, path, probe.home)
              : probe.kind === "minimax" && probe.home !== null
                ? minimaxProbe(client, fileSystem, path, probe.home)
                : probe.kind === "factory"
                  ? factoryProbe(probe.etcdKey)
                  : Effect.fail(
                      new UsageQuotaProbeError({
                        probe: probe.kind,
                        detail: "instance home could not be resolved",
                      }),
                    );

    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const limits = yield* run.pipe(
      Effect.catch((error: UsageQuotaProbeError) =>
        Effect.succeed(windowUnavailable(checkedAt, error.detail)),
      ),
    );
    cache.set(instanceKey, { atMs: nowMs, limits });
    return limits;
  },
);

/** Test hook: drop all cached windows. */
export const clearUsageQuotaProbeCache = (): void => {
  cache.clear();
};
