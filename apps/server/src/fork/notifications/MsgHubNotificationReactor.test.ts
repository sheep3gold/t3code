// @effect-diagnostics preferSucceedSomeOrNone:off -- fork code predates these upstream style rules.
import { assert, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2TurnItem,
  TurnItemId,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Exit from "effect/Exit";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as AgentNotification from "./AgentNotification.ts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { startMsgHubNotifications } from "./MsgHubNotificationReactor.ts";

const THREAD_ID = ThreadId.make("notify-thread");
const PROJECT_ID = ProjectId.make("notify-project");
const NOW = "2026-10-18T00:00:00.000Z";
const now = DateTime.makeUnsafe(NOW);
function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "running",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe(NOW),
    updatedAt: DateTime.makeUnsafe(NOW),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

function run(status: OrchestrationV2Run["status"]): OrchestrationV2Run {
  return {
    id: RunId.make("run-1"),
    threadId: THREAD_ID,
    ordinal: 1,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    providerThreadId: null,
    userMessageId: MessageId.make("user-1"),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: now,
    completedAt: status === "running" ? null : now,
    checkpointId: null,
    contextHandoffId: null,
  };
}
function request(
  kind: OrchestrationV2RuntimeRequest["kind"],
  status: OrchestrationV2RuntimeRequest["status"] = "pending",
): OrchestrationV2RuntimeRequest {
  return {
    id: RuntimeRequestId.make(`request-${kind}`),
    nodeId: NodeId.make("node-1"),
    providerTurnId: null,
    nativeRequestRef: null,
    kind,
    status,
    responseCapability: { type: "message" },
    createdAt: now,
    resolvedAt: null,
  };
}
function runEvent(status: OrchestrationV2Run["status"]): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event-${status}`),
    threadId: THREAD_ID,
    occurredAt: now,
    type: "run.updated",
    payload: run(status),
  };
}
function requestEvent(
  kind: OrchestrationV2RuntimeRequest["kind"],
  status?: OrchestrationV2RuntimeRequest["status"],
): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event-${kind}-${status}`),
    threadId: THREAD_ID,
    occurredAt: now,
    type: "runtime-request.updated",
    payload: request(kind, status),
  };
}

const messages: ReadonlyArray<OrchestrationV2ConversationMessage> = [
  {
    id: MessageId.make("reply-1"),
    threadId: THREAD_ID,
    runId: RunId.make("run-1"),
    nodeId: null,
    role: "assistant",
    text: "Finished the requested change.",
    attachments: [],
    streaming: false,
    createdAt: now,
    updatedAt: now,
    createdBy: "agent",
    creationSource: "provider",
  },
];
const itemBase = {
  threadId: THREAD_ID,
  runId: RunId.make("run-1"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "waiting" as const,
  title: null,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
};
const turnItems: ReadonlyArray<OrchestrationV2TurnItem> = [
  {
    ...itemBase,
    id: TurnItemId.make("approval"),
    type: "approval_request",
    requestId: RuntimeRequestId.make("request-command"),
    requestKind: "command",
    prompt: "Allow build?",
  },
  {
    ...itemBase,
    id: TurnItemId.make("question"),
    type: "user_input_request",
    requestId: RuntimeRequestId.make("request-user_input"),
    questions: [{ id: "q", header: "Choice", question: "Which environment?", options: [] }],
  },
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const exercise = Effect.fnUntraced(function* (
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  options: { disabled?: boolean; deleted?: boolean; failFirst?: boolean } = {},
) {
  vi.stubEnv("T3CODE_MSGHUB_NOTIFY", options.disabled ? "0" : "1");
  vi.stubEnv("T3CODE_MSGHUB_TOKEN", "test-token");
  vi.stubEnv("T3CODE_MSGHUB_URL", "https://mq.example.test");
  const sent: Array<{ subject: string; payload: string; msg_id: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response("", { status: options.failFirst && sent.length === 1 ? 403 : 200 });
    }),
  );
  const done = yield* Deferred.make<void>();
  const getThreadShell = vi.fn(() =>
    Effect.succeed(shell({ deletedAt: options.deleted ? now : null })),
  );
  const layer = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.fromIterable(events).pipe(
        Stream.concat(Stream.fromEffect(Deferred.succeed(done, undefined)).pipe(Stream.drain)),
      ),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell,
      getThreadRecords: () => Effect.succeed({ messages, turnItems } as never),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({ getShell: () => Effect.succeed(Option.none()) }),
  );
  yield* startMsgHubNotifications.pipe(Effect.provide(layer));
  if (!options.disabled) yield* Deferred.await(done);
  return { sent, getThreadShell };
});

it.effect(
  "notifies terminal runs and pending human requests, ignoring running and resolved/internal requests",
  () =>
    Effect.gen(function* () {
      const { sent } = yield* exercise([
        runEvent("running"),
        runEvent("completed"),
        runEvent("failed"),
        runEvent("interrupted"),
        runEvent("cancelled"),
        requestEvent("command"),
        requestEvent("user_input"),
        requestEvent("user_input", "resolved"),
        requestEvent("dynamic_tool_call"),
        requestEvent("auth_refresh"),
      ]);
      assert.equal(sent.length, 6);
      assert.equal(JSON.parse(sent[0]!.payload).text, "Finished the requested change.");
      assert.equal(JSON.parse(sent[4]!.payload).text, "Allow build?");
      assert.equal(JSON.parse(sent[5]!.payload).text, "Which environment?");
      assert.equal(sent.filter((message) => message.subject.endsWith("turn.done")).length, 4);
      assert.isTrue(sent[4]!.subject.endsWith("approval.required"));
      assert.isTrue(sent[5]!.subject.endsWith("user-input.required"));
    }),
);

it.effect("keeps consuming after a publish failure and preserves deduplication ids", () =>
  Effect.gen(function* () {
    const { sent } = yield* exercise(
      [runEvent("completed"), runEvent("completed"), requestEvent("command")],
      { failFirst: true },
    );
    assert.equal(sent.length, 3);
    assert.equal(sent[0]!.msg_id, sent[1]!.msg_id);
    assert.notEqual(sent[1]!.msg_id, sent[2]!.msg_id);
  }),
);

it.effect("does not read threads or publish when notifications are disabled", () =>
  Effect.gen(function* () {
    const { sent, getThreadShell } = yield* exercise([runEvent("completed")], { disabled: true });
    assert.equal(sent.length, 0);
    assert.equal(getThreadShell.mock.calls.length, 0);
  }),
);

it.effect("does not notify deleted threads", () =>
  Effect.gen(function* () {
    const { sent } = yield* exercise([runEvent("completed"), requestEvent("command")], {
      deleted: true,
    });
    assert.equal(sent.length, 0);
  }),
);

it.effect.each(["active", "inactive", "read-only"] as const)(
  "agent notification respects %s caller permissions",
  (mode) =>
    Effect.gen(function* () {
      vi.stubEnv("T3CODE_MSGHUB_NOTIFY", "1");
      vi.stubEnv("T3CODE_MSGHUB_TOKEN", "test-token");
      vi.stubEnv("T3CODE_MSGHUB_URL", "https://mq.example.test");
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response("", { status: 200 }));
      vi.stubGlobal("fetch", fetch);
      const thread = shell({ activeRunId: mode === "inactive" ? null : RunId.make("run-1") });
      const dependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () => Effect.succeed(thread),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(thread),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({ getShell: () => Effect.succeedNone }),
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("notify-env"),
          requestNamespace: "notify-test",
          issuedAt: 0,
          capabilities: new Set(["orchestration"] as const),
          thread: {
            threadId: THREAD_ID,
            providerSessionId: "session-1",
            providerInstanceId: thread.providerInstanceId,
          },
          client:
            mode === "read-only"
              ? { sessionId: "client-1", label: "reader", access: "read-only" }
              : undefined,
        }),
      );
      const result = yield* Effect.gen(function* () {
        const toolkit = yield* AgentNotification.AgentNotificationToolkit;
        return yield* toolkit
          .handle("send_notification", {
            title: "Progress",
            text: "Build done",
            dedupeKey: "build-1",
          })
          .pipe(Stream.unwrap, Stream.runCollect);
      }).pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(
            AgentNotification.AgentNotificationToolkitHandlersLive,
          ).pipe(Layer.provideMerge(dependencies)),
        ),
        Effect.exit,
      );
      assert.equal(Exit.isSuccess(result), mode === "active");
      assert.equal(fetch.mock.calls.length, mode === "active" ? 1 : 0);
    }),
);
