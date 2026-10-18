// @effect-diagnostics nodeBuiltinImport:off -- preserve stable notification deduplication ids.
import * as NodeCrypto from "node:crypto";

import { OrchestratorMcpFailure, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import {
  buildMsgHubPublishRequest,
  publishMsgHubRequest,
  resolveMsgHubPublisherConfig,
  type MsgHubEnvironment,
  type MsgHubFetch,
} from "./MsgHubPublisher.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";

export const DEFAULT_AGENT_NOTIFICATION_SUBJECT = "dingding.notify.vibecoding.t3code.agent.message";
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
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}
export class AgentNotificationPublishError extends Schema.TaggedError<AgentNotificationPublishError>()(
  "AgentNotificationPublishError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not publish the agent notification.";
  }
}
const AgentNotificationToolError = Schema.Union([
  OrchestratorMcpFailure,
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
    ProjectionStore.ProjectionStoreV2,
    ProjectStore.ProjectStoreV2,
    ThreadManagementService.ThreadManagementService,
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
    // @effect-diagnostics-next-line globalDate:off -- plain payload builder, parses a timestamp the caller already produced.
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

export const AgentNotificationToolkitHandlersLive = McpToolAccess.toLayer(
  AgentNotificationToolkit,
  {
    send_notification: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const caller = yield* McpInvocationContext.requireThreadScope(scope, "Agent notifications");
        const threadId = ThreadId.make(caller.thread.threadId);
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const crypto = yield* Crypto.Crypto;
        const thread = yield* projections
          .getThreadShell(threadId)
          .pipe(Effect.mapError((cause) => new AgentNotificationPublishError({ cause })));
        if (thread === null || thread.archivedAt !== null || thread.deletedAt !== null) {
          return yield* new AgentNotificationThreadNotFoundError({ threadId });
        }
        const project = Option.getOrUndefined(
          yield* projects
            .getShell(thread.projectId)
            .pipe(Effect.mapError((cause) => new AgentNotificationPublishError({ cause }))),
        );
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const dedupeKey = input.dedupeKey ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
        return yield* Effect.tryPromise({
          try: () =>
            publishAgentNotification({
              title: input.title,
              text: input.text,
              level: input.level ?? "info",
              threadId,
              threadTitle: thread.title,
              project: project?.title || project?.workspaceRoot.split(/[\\/]/).at(-1) || "project",
              dedupeKey,
              createdAt,
            }),
          catch: (cause) => new AgentNotificationPublishError({ cause }),
        });
      }),
    ),
  },
);
