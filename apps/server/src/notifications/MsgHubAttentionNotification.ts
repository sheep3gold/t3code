// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  resolveMsgHubTurnCompletionConfig,
  type MsgHubTurnCompletionConfig,
  type MsgHubTurnCompletionRequest,
} from "./MsgHubTurnCompletion.ts";

export const DEFAULT_APPROVAL_REQUIRED_SUBJECT =
  "dingding.notify.vibecoding.t3code.approval.required";
export const DEFAULT_USER_INPUT_REQUIRED_SUBJECT =
  "dingding.notify.vibecoding.t3code.user-input.required";

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 3;
const MAX_TEXT_CHARS = 1_100;

type Environment = Readonly<Record<string, string | undefined>>;
type Fetch = typeof globalThis.fetch;

export type AttentionNotificationKind = "approval" | "user-input";

export interface AttentionNotificationInput {
  readonly kind: AttentionNotificationKind;
  readonly eventId: string;
  readonly requestId?: string | undefined;
  readonly threadId: string;
  readonly turnId?: string | undefined;
  readonly project: string;
  readonly threadTitle: string;
  readonly provider: string;
  readonly text: string;
  readonly createdAt: string;
}

function cleanText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, "〔代码块〕")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clipText(value: string): string {
  const characters = Array.from(value);
  return characters.length <= MAX_TEXT_CHARS
    ? value
    : `${characters.slice(0, MAX_TEXT_CHARS).join("")}…（回 T3Code 查看完整内容）`;
}

export function resolveMsgHubAttentionConfig(
  kind: AttentionNotificationKind,
  environment: Environment = process.env,
): MsgHubTurnCompletionConfig | null {
  const base = resolveMsgHubTurnCompletionConfig(environment);
  if (base === null) return null;
  return {
    ...base,
    subject:
      kind === "approval"
        ? environment.T3CODE_MSGHUB_APPROVAL_SUBJECT?.trim() ||
          DEFAULT_APPROVAL_REQUIRED_SUBJECT
        : environment.T3CODE_MSGHUB_USER_INPUT_SUBJECT?.trim() ||
          DEFAULT_USER_INPUT_REQUIRED_SUBJECT,
  };
}

export function buildMsgHubAttentionRequest(
  input: AttentionNotificationInput,
  config: MsgHubTurnCompletionConfig,
): MsgHubTurnCompletionRequest {
  const isApproval = input.kind === "approval";
  const label = isApproval ? "等待审批" : "等待回答";
  const marker = isApproval ? "⏳" : "❓";
  const fallback = isApproval
    ? "T3Code 正在等待审批，请回到会话处理。"
    : "T3Code 正在等待回答，请回到会话处理。";
  const text = clipText(cleanText(input.text) || fallback);
  const digest = NodeCrypto.createHash("sha1")
    .update(
      `${config.hostLabel}|${input.kind}|${input.threadId}|${input.requestId ?? input.eventId}`,
    )
    .digest("hex")
    .slice(0, 16);
  const payload = {
    title: `[${config.hostLabel}] ${marker} T3Code(${input.project}) ${label}`,
    text,
    level: "warning",
    source: `t3code/${input.project}`,
    host: config.hostLabel,
    ts: Math.floor(new Date(input.createdAt).getTime() / 1_000),
    fields: {
      主机: config.hostLabel,
      项目: input.project,
      会话: input.threadTitle,
      Provider: input.provider,
      类型: input.kind,
    },
  };
  return {
    url: `${config.baseUrl}/api/publish`,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      subject: config.subject,
      payload: JSON.stringify(payload),
      msg_id: `t3-attention-${digest}`,
    }),
  };
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function publishAttentionNotification(
  input: AttentionNotificationInput,
  options: {
    readonly environment?: Environment;
    readonly fetch?: Fetch;
  } = {},
): Promise<"disabled" | "sent"> {
  const config = resolveMsgHubAttentionConfig(input.kind, options.environment);
  if (config === null) return "disabled";
  const request = buildMsgHubAttentionRequest(input, config);
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

  throw new Error(`msghub attention notification failed: ${lastError}`);
}
