/**
 * 模型网关会话路由查询。
 *
 * 后端接口：GET {baseUrl}/session/by-id/{session_id}
 * 返回：{ session_key, tier, base_tier, cause, level, escalation, provider, model, deployment, ts, last_status }
 *
 * 桌面端访问本机网关 http://127.0.0.1:4010；手机端通过内网/SSH 隧道将 baseUrl 指向网关可达地址。
 * 接口免鉴权，失败时返回 null 且不影响主对话流程。
 */

export interface SessionRouteInfo {
  readonly sessionKey: string;
  readonly tier: string;
  readonly baseTier: string;
  readonly provider: string;
  readonly model: string;
  readonly deployment: string;
  readonly lastStatus: string;
  readonly ts: number;
}

/** 显示文本：glm/glm-5.3 (MEDIUM档) */
export function formatSessionRouteLabel(input: {
  readonly provider: string;
  readonly model: string;
  readonly tier: string;
}): string {
  const { provider, model, tier } = input;
  const section = provider && model ? `${provider}/${model}` : "";
  return tier ? `${section} (${tier}档)` : section;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:4010";
const DEFAULT_TIMEOUT_MS = 2000;

export async function fetchSessionRoute(
  sessionId: string,
  options: {
    readonly baseUrl?: string | null;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<SessionRouteInfo | null> {
  const { baseUrl = DEFAULT_BASE_URL, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;
  const url = `${baseUrl.replace(/\/$/, "")}/session/by-id/${encodeURIComponent(sessionId)}`;

  let controller: AbortController | null = null;
  if (!signal) {
    controller = new AbortController();
  }
  const abortSignal = signal ?? controller!.signal;

  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      controller?.abort();
      abortSignal.dispatchEvent(new Event("abort"));
    }, timeoutMs);
  }

  try {
    const response = await fetch(url, {
      signal: abortSignal,
      headers: { Accept: "application/json" },
      // 网关免鉴权，无需携带凭证；保持无缓存以拿到最新路由。
      cache: "no-store",
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as unknown;
    return decodeSessionRoute(data);
  } catch {
    // 网络不通、会话过期、超时等全部视为“暂不可用”，不向用户报错。
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function decodeSessionRoute(data: unknown): SessionRouteInfo | null {
  if (data === null || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if ("error" in record && record["error"] !== null && record["error"] !== undefined) {
    return null;
  }
  const provider = record["provider"];
  const model = record["model"];
  const tier = record["tier"];
  if (typeof provider !== "string" || typeof model !== "string" || typeof tier !== "string") {
    return null;
  }
  return {
    sessionKey: typeof record["session_key"] === "string" ? record["session_key"] : "",
    tier,
    baseTier: typeof record["base_tier"] === "string" ? record["base_tier"] : "",
    provider,
    model,
    deployment: typeof record["deployment"] === "string" ? record["deployment"] : "",
    lastStatus: typeof record["last_status"] === "string" ? record["last_status"] : "",
    ts: typeof record["ts"] === "number" ? record["ts"] : 0,
  };
}
