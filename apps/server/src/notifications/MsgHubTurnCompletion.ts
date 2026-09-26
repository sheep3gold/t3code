// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeOs from "node:os";

const DEFAULT_BASE_URL = "https://mq.zxytech.cn";
export const DEFAULT_TURN_COMPLETION_SUBJECT =
  "dingding.notify.vibecoding.t3code.turn.done";
const MAX_TEXT_CHARS = 1_100;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 3;

export type TurnCompletionState = "completed" | "failed" | "interrupted" | "cancelled";

export interface TurnCompletionNotificationInput {
  readonly threadId: string;
  readonly turnId: string;
  readonly project: string;
  readonly threadTitle: string;
  readonly provider: string;
  readonly state: TurnCompletionState;
  readonly text: string;
  readonly errorMessage?: string | undefined;
  readonly createdAt: string;
}

export interface UnexpectedTurnInterruption {
  readonly turnId: string;
  readonly errorMessage: string;
}

export function resolveUnexpectedTurnInterruption(
  activeTurnId: string | null | undefined,
  reason?: string,
): UnexpectedTurnInterruption | null {
  if (!activeTurnId) return null;
  return {
    turnId: activeTurnId,
    errorMessage:
      reason?.trim() || "Provider session exited before the active turn reported completion.",
  };
}

export interface MsgHubTurnCompletionConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly subject: string;
  readonly hostLabel: string;
}

export interface MsgHubTurnCompletionRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

type Environment = Readonly<Record<string, string | undefined>>;
type Fetch = typeof globalThis.fetch;

function normalizedBaseUrl(value: string | undefined): string {
  return (value?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function cleanText(value: string): string {
  return value
    .replace(/\n\[OPTIONS:.*$/s, "")
    .replace(/```[\s\S]*?```/g, "〔代码块〕")
    .replace(/<mcwidget[^>]*>[\s\S]*?<\/mcwidget>/g, "〔组件〕")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function clipText(value: string): { readonly text: string; readonly originalLength: number } {
  const characters = Array.from(value);
  if (characters.length <= MAX_TEXT_CHARS) {
    return { text: value, originalLength: characters.length };
  }
  return {
    text: `${characters.slice(0, MAX_TEXT_CHARS).join("")}…（完整 ${characters.length} 字，回 T3Code 查看）`,
    originalLength: characters.length,
  };
}

function presentation(state: TurnCompletionState): {
  readonly marker: string;
  readonly label: string;
  readonly level: "success" | "failed" | "warning";
} {
  switch (state) {
    case "failed":
      return { marker: "❌", label: "失败", level: "failed" };
    case "interrupted":
    case "cancelled":
      return { marker: "⚠️", label: "已中断", level: "warning" };
    case "completed":
      return { marker: "✅", label: "回复完成", level: "success" };
  }
}

export function resolveMsgHubTurnCompletionConfig(
  environment: Environment = process.env,
): MsgHubTurnCompletionConfig | null {
  if (environment.T3CODE_MSGHUB_NOTIFY !== "1") return null;
  const token = environment.T3CODE_MSGHUB_TOKEN?.trim();
  if (!token) return null;
  return {
    baseUrl: normalizedBaseUrl(environment.T3CODE_MSGHUB_URL),
    token,
    subject:
      environment.T3CODE_MSGHUB_SUBJECT?.trim() || DEFAULT_TURN_COMPLETION_SUBJECT,
    hostLabel:
      environment.T3CODE_MSGHUB_HOST_LABEL?.trim().slice(0, 32) ||
      NodeOs.hostname().split(".")[0] ||
      "unknown",
  };
}

export function buildMsgHubTurnCompletionRequest(
  input: TurnCompletionNotificationInput,
  config: MsgHubTurnCompletionConfig,
): MsgHubTurnCompletionRequest {
  const display = presentation(input.state);
  const cleaned = cleanText(input.text);
  const fallback =
    input.errorMessage?.trim() ||
    (input.state === "completed"
      ? "T3Code 已完成本轮回复，回到会话查看详情。"
      : `T3Code 本轮${display.label}，回到会话查看详情。`);
  const clipped = clipText(cleaned || fallback);
  const title = `[${config.hostLabel}] ${display.marker} T3Code(${input.project}) ${display.label}`;
  const payload = {
    title,
    text: clipped.text,
    level: display.level,
    source: `t3code/${input.project}`,
    host: config.hostLabel,
    ts: Math.floor(new Date(input.createdAt).getTime() / 1_000),
    fields: {
      主机: config.hostLabel,
      项目: input.project,
      会话: input.threadTitle,
      Provider: input.provider,
      状态: input.state,
      回复字数: String(clipped.originalLength),
      ...(clipped.originalLength > MAX_TEXT_CHARS
        ? { 本条状态: `已截断，仅前 ${MAX_TEXT_CHARS} 字` }
        : {}),
    },
  };
  const digest = NodeCrypto.createHash("sha1")
    .update(`${config.hostLabel}|${input.threadId}|${input.turnId}`)
    .digest("hex")
    .slice(0, 16);
  return {
    url: `${config.baseUrl}/api/publish`,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      subject: config.subject,
      payload: JSON.stringify(payload),
      msg_id: `t3-turn-${digest}`,
    }),
  };
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function publishTurnCompletionNotification(
  input: TurnCompletionNotificationInput,
  options: {
    readonly environment?: Environment;
    readonly fetch?: Fetch;
  } = {},
): Promise<"disabled" | "sent"> {
  const config = resolveMsgHubTurnCompletionConfig(options.environment);
  if (config === null) return "disabled";
  const request = buildMsgHubTurnCompletionRequest(input, config);
  const fetchRequest = options.fetch ?? globalThis.fetch;
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
      if (response.ok) return "sent";
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

  throw new Error(`msghub turn notification failed: ${lastError}`);
}
