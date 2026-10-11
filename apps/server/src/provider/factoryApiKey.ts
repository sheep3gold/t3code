// @effect-diagnostics nodeBuiltinImport:off - the bootstrap file read happens inside a promise-based fetch helper
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

const DEFAULT_TTL_MS = 5_000;
const FETCH_TIMEOUT_MS = 3_000;

export interface FactoryApiKeyResolver {
  /**
   * `baseEnvironment` with `FACTORY_API_KEY` set to the current key. Called at
   * every droid spawn, so a key rotated in etcd is picked up by the next one.
   */
  readonly environment: Effect.Effect<NodeJS.ProcessEnv>;
}

/** Every spelling droid or its libraries may read; the lowercase ones win in some runtimes. */
const PROXY_ENV_NAMES = ["https_proxy", "http_proxy", "HTTPS_PROXY", "HTTP_PROXY"] as const;
const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,::1";

/**
 * `environment` with every Droid-bound request sent through `proxyUrl`
 * (loopback stays direct). An empty `proxyUrl` leaves the environment alone.
 */
export function withFactoryProxy(
  environment: NodeJS.ProcessEnv,
  proxyUrl: string | undefined,
): NodeJS.ProcessEnv {
  const url = proxyUrl?.trim();
  if (!url) return environment;
  const proxied: NodeJS.ProcessEnv = {
    ...environment,
    no_proxy: LOOPBACK_NO_PROXY,
    NO_PROXY: LOOPBACK_NO_PROXY,
  };
  for (const name of PROXY_ENV_NAMES) proxied[name] = url;
  return proxied;
}

/** Stable, non-reversible identity of a key, for "did it change" checks. */
export function factoryApiKeyFingerprint(environment: NodeJS.ProcessEnv): string {
  const key = environment.FACTORY_API_KEY?.trim();
  return key ? NodeCrypto.createHash("sha256").update(key).digest("hex").slice(0, 16) : "";
}

function defaultBootstrapPath(): string {
  const home = process.env.T3CODE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".t3");
  return NodePath.join(home, "t3code-etcd-bootstrap.env");
}

async function readBootstrap(path: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of (await NodeFS.readFile(path, "utf8")).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    values[trimmed.slice(0, index).trim()] = trimmed
      .slice(index + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return values;
}

async function fetchEtcdValue(
  fetchImpl: typeof fetch,
  bootstrapPath: string,
  etcdKey: string,
): Promise<string | undefined> {
  const cfg = await readBootstrap(bootstrapPath);
  if (!cfg.ETCD_ENDPOINT || !cfg.ETCD_BASIC_USER || !cfg.ETCD_BASIC_PASS) {
    throw new Error("etcd bootstrap file is missing endpoint or credentials");
  }
  const response = await fetchImpl(`${cfg.ETCD_ENDPOINT.replace(/\/+$/, "")}/v3/kv/range`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${cfg.ETCD_BASIC_USER}:${cfg.ETCD_BASIC_PASS}`).toString("base64")}`,
    },
    body: JSON.stringify({ key: Buffer.from(etcdKey).toString("base64") }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`etcd responded ${response.status}`);
  const payload = (await response.json()) as { kvs?: ReadonlyArray<{ value?: string }> };
  const value = payload.kvs?.[0]?.value;
  return value ? Buffer.from(value, "base64").toString("utf8").trim() || undefined : undefined;
}

/**
 * Reads the Factory API key from etcd on demand. Order of preference: etcd
 * (cached for a few seconds), the last value etcd returned, then whatever
 * `FACTORY_API_KEY` the server was started with. With no `etcdKey` configured
 * it is a pass-through of the base environment.
 *
 * The key itself is never logged; failures report only the reason.
 */
export function makeFactoryApiKeyResolver(input: {
  readonly etcdKey: string | undefined;
  /** Outbound proxy for everything Droid sends to Factory, e.g. the xjp node. */
  readonly proxyUrl?: string;
  readonly baseEnvironment: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly bootstrapPath?: string;
  readonly ttlMs?: number;
  readonly now?: () => number;
}): FactoryApiKeyResolver {
  const etcdKey = input.etcdKey?.trim();
  const baseEnvironment = withFactoryProxy(input.baseEnvironment, input.proxyUrl);
  if (!etcdKey) return { environment: Effect.succeed(baseEnvironment) };
  const fetchImpl = input.fetchImpl ?? fetch;
  const bootstrapPath = input.bootstrapPath ?? defaultBootstrapPath();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const now = input.now ?? Date.now;
  let cached: { readonly value: string; readonly at: number } | undefined;

  const resolveKey = Effect.gen(function* () {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    const fetched = yield* Effect.tryPromise(() =>
      fetchEtcdValue(fetchImpl, bootstrapPath, etcdKey),
    ).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Factory API key lookup in etcd failed", {
          etcdKey,
          reason: cause.cause instanceof Error ? cause.cause.message : "unknown",
        }),
      ),
      Effect.option,
    );
    if (fetched._tag === "Some" && fetched.value) {
      cached = { value: fetched.value, at: now() };
      return fetched.value;
    }
    return cached?.value;
  });

  return {
    environment: resolveKey.pipe(
      Effect.map((key) => (key ? { ...baseEnvironment, FACTORY_API_KEY: key } : baseEnvironment)),
    ),
  };
}
