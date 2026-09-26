// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  resolveMsgHubTurnCompletionConfig,
  type MsgHubTurnCompletionConfig,
  type MsgHubTurnCompletionRequest,
} from "./MsgHubTurnCompletion.ts";
import {
  buildMsgHubPublishRequest,
  publishMsgHubRequest,
  type MsgHubEnvironment,
  type MsgHubFetch,
} from "./MsgHubPublisher.ts";

export const DEFAULT_APPROVAL_REQUIRED_SUBJECT =
  "dingding.notify.vibecoding.t3code.approval.required";
export const DEFAULT_USER_INPUT_REQUIRED_SUBJECT =
  "dingding.notify.vibecoding.t3code.user-input.required";

const MAX_TEXT_CHARS = 1_100;

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
  environment: MsgHubEnvironment = process.env,
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
  return buildMsgHubPublishRequest({
    config,
    subject: config.subject,
    payload,
    messageId: `t3-attention-${digest}`,
  });
}

export async function publishAttentionNotification(
  input: AttentionNotificationInput,
  options: {
    readonly environment?: MsgHubEnvironment;
    readonly fetch?: MsgHubFetch;
  } = {},
): Promise<"disabled" | "sent"> {
  const config = resolveMsgHubAttentionConfig(input.kind, options.environment);
  if (config === null) return "disabled";
  await publishMsgHubRequest(
    buildMsgHubAttentionRequest(input, config),
    options.fetch ?? globalThis.fetch,
  );
  return "sent";
}
