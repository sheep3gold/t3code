import * as NodeOs from "node:os";

const DEFAULT_BASE_URL = "https://mq.zxytech.cn";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 3;

export type MsgHubEnvironment = Readonly<Record<string, string | undefined>>;
export type MsgHubFetch = typeof globalThis.fetch;

export interface MsgHubPublisherConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly hostLabel: string;
}

export interface MsgHubPublishRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export function resolveMsgHubPublisherConfig(
  environment: MsgHubEnvironment = process.env,
): MsgHubPublisherConfig | null {
  if (environment.T3CODE_MSGHUB_NOTIFY !== "1") return null;
  const token = environment.T3CODE_MSGHUB_TOKEN?.trim();
  if (!token) return null;
  return {
    baseUrl: (environment.T3CODE_MSGHUB_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    token,
    hostLabel:
      environment.T3CODE_MSGHUB_HOST_LABEL?.trim().slice(0, 32) ||
      NodeOs.hostname().split(".")[0] ||
      "unknown",
  };
}

export function buildMsgHubPublishRequest(input: {
  readonly config: MsgHubPublisherConfig;
  readonly subject: string;
  readonly payload: unknown;
  readonly messageId: string;
}): MsgHubPublishRequest {
  return {
    url: `${input.config.baseUrl}/api/publish`,
    headers: {
      Authorization: `Bearer ${input.config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      subject: input.subject,
      payload: JSON.stringify(input.payload),
      msg_id: input.messageId,
    }),
  };
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function publishMsgHubRequest(
  request: MsgHubPublishRequest,
  fetchRequest: MsgHubFetch = globalThis.fetch,
): Promise<void> {
  let lastError = "unknown error";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchRequest(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      if (response.ok) return;
      const detail = (await response.text()).slice(0, 200);
      lastError = `HTTP ${response.status}${detail ? ` ${detail}` : ""}`;
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < MAX_ATTEMPTS - 1) await delay(1_500 * (attempt + 1));
  }
  throw new Error(`msghub publish failed: ${lastError}`);
}
