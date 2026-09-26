import * as NodeCrypto from "node:crypto";

import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import {
  buildMsgHubPublishRequest,
  publishMsgHubRequest,
  resolveMsgHubPublisherConfig,
  type MsgHubEnvironment,
  type MsgHubFetch,
} from "./MsgHubPublisher.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export const DEFAULT_AGENT_NOTIFICATION_SUBJECT =
  "dingding.notify.vibecoding.t3code.agent.message";
const MAX_TITLE_CHARS = 200;
const MAX_TEXT_CHARS = 1_100;

const SendNotificationInput = Schema.Struct({
  title: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  level: Schema.optional(Schema.Literals(["info", "success", "warning", "failed"])),
  dedupeKey: Schema.optional(TrimmedNonEmptyString),
});
const SendNotificationResult = Schema.Struct({
  status: Schema.Literals(["disabled", "sent"]),
  messageId: Schema.String,
});
type SendNotificationResult = typeof SendNotificationResult.Type;

export class AgentNotificationThreadNotFoundError extends Schema.TaggedError<AgentNotificationThreadNotFoundError>()(
  "AgentNotificationThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string { return `Thread ${this.threadId} was not found.`; }
}
export class AgentNotificationPublishError extends Schema.TaggedError<AgentNotificationPublishError>()(
  "AgentNotificationPublishError",
  { cause: Schema.Defect() },
) {
  override get message(): string { return "Could not publish the agent notification."; }
}
const AgentNotificationToolError = Schema.Union([
  AgentNotificationThreadNotFoundError,
  AgentNotificationPublishError,
]);

const SendNotificationTool = Tool.make("send_notification", {
  description:
    "Send a proactive notification about this thread through the environment's configured message router. The server chooses the restricted subject and downstream channels; this tool cannot address another topic or recipient. Use dedupeKey when retries must not duplicate a notification.",
  parameters: SendNotificationInput,
  success: SendNotificationResult,
  failure: AgentNotificationToolError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ProjectionSnapshotQuery.ProjectionSnapshotQuery,
    Crypto.Crypto,
    Clock.Clock,
  ],
})
  .annotate(Tool.Title, "Send thread notification")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const AgentNotificationToolkit = Toolkit.make(SendNotificationTool);

function clip(value: string, limit: number): string {
  return Array.from(value.trim()).slice(0, limit).join("");
}

export function buildAgentNotification(input: {
  readonly title: string;
  readonly text: string;
  readonly level: "info" | "success" | "warning" | "failed";
  readonly threadId: string;
  readonly threadTitle: string;
  readonly project: string;
  readonly hostLabel: string;
  readonly createdAt: string;
}) {
  return {
    title: `[${input.hostLabel}] ${clip(input.title, MAX_TITLE_CHARS)}`,
    text: clip(input.text, MAX_TEXT_CHARS),
    level: input.level,
    source: `t3code/${input.project}`,
    host: input.hostLabel,
    ts: Math.floor(new Date(input.createdAt).getTime() / 1_000),
    fields: {
      主机: input.hostLabel,
      项目: input.project,
      会话: input.threadTitle,
      Thread: input.threadId,
      类型: "agent",
    },
  };
}

export async function publishAgentNotification(
  input: {
    readonly title: string;
    readonly text: string;
    readonly level: "info" | "success" | "warning" | "failed";
    readonly threadId: string;
    readonly threadTitle: string;
    readonly project: string;
    readonly dedupeKey: string;
    readonly createdAt: string;
  },
  options: {
    readonly environment?: MsgHubEnvironment;
    readonly fetch?: MsgHubFetch;
  } = {},
): Promise<SendNotificationResult> {
  const environment = options.environment ?? process.env;
  const config = resolveMsgHubPublisherConfig(environment);
  const digest = NodeCrypto.createHash("sha256")
    .update(`${input.threadId}|${input.dedupeKey}`)
    .digest("hex")
    .slice(0, 20);
  const messageId = `t3-agent-${digest}`;
  if (config === null) return { status: "disabled", messageId };
  const subject =
    environment.T3CODE_MSGHUB_AGENT_SUBJECT?.trim() || DEFAULT_AGENT_NOTIFICATION_SUBJECT;
  await publishMsgHubRequest(
    buildMsgHubPublishRequest({
      config,
      subject,
      payload: buildAgentNotification({ ...input, hostLabel: config.hostLabel }),
      messageId,
    }),
    options.fetch ?? globalThis.fetch,
  );
  return { status: "sent", messageId };
}

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  return AgentNotificationToolkit.of({
    send_notification: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const thread = yield* snapshots
          .getThreadShellById(scope.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (!thread || thread.archivedAt !== null || thread.deletedAt !== null) {
          return yield* new AgentNotificationThreadNotFoundError({ threadId: scope.threadId });
        }
        const project = yield* snapshots
          .getProjectShellById(thread.projectId)
          .pipe(Effect.map(Option.getOrUndefined));
        const createdAt = new Date(yield* Clock.currentTimeMillis).toISOString();
        const dedupeKey = input.dedupeKey ?? (yield* crypto.randomUUIDv4);
        return yield* Effect.promise(() =>
          publishAgentNotification({
            title: input.title,
            text: input.text,
            level: input.level ?? "info",
            threadId: String(thread.id),
            threadTitle: thread.title,
            project: project?.title || project?.workspaceRoot.split(/[\\/]/).at(-1) || "project",
            dedupeKey,
            createdAt,
          }),
        ).pipe(
          Effect.mapError((cause) => new AgentNotificationPublishError({ cause })),
        );
      }),
  });
});

export const AgentNotificationToolkitHandlersLive = AgentNotificationToolkit.toLayer(make);
