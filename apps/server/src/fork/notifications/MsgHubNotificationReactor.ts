import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  publishAttentionNotification,
  resolveMsgHubAttentionConfig,
} from "./MsgHubAttentionNotification.ts";
import {
  publishTurnCompletionNotification,
  resolveMsgHubTurnCompletionConfig,
  type TurnCompletionState,
} from "./MsgHubTurnCompletion.ts";

const TERMINAL: ReadonlyMap<OrchestrationV2Run["status"], TurnCompletionState> = new Map([
  ["completed", "completed"],
  ["failed", "failed"],
  ["interrupted", "interrupted"],
  ["cancelled", "cancelled"],
]);

function turnCompletionState(run: OrchestrationV2Run): TurnCompletionState | undefined {
  return TERMINAL.get(run.status);
}

function attentionKind(
  request: OrchestrationV2RuntimeRequest,
): "approval" | "user-input" | undefined {
  if (request.status !== "pending") return undefined;
  if (request.kind === "user_input") return "user-input";
  if (request.kind === "dynamic_tool_call" || request.kind === "auth_refresh") return undefined;
  return "approval";
}

/**
 * Publishes the fork's DingTalk/Bark notices through msghub: a finished,
 * failed or interrupted turn, and a turn waiting on an approval or answer.
 * msghub de-duplicates on the deterministic message id, so a replayed event
 * does not notify twice.
 */
export const startMsgHubNotifications = Effect.gen(function* () {
  if (resolveMsgHubTurnCompletionConfig() === null) return;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;

  const describeThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const shell = yield* projections.getThreadShell(threadId);
    if (shell === null || shell.deletedAt !== null) return undefined;
    const project = Option.getOrUndefined(yield* projects.getShell(shell.projectId));
    return {
      shell,
      project:
        project?.title || project?.workspaceRoot.split(/[\\/]/).at(-1) || String(shell.projectId),
    };
  });

  const onRun = Effect.fnUntraced(function* (threadId: ThreadId, run: OrchestrationV2Run) {
    const state = turnCompletionState(run);
    if (state === undefined) return;
    const thread = yield* describeThread(threadId);
    if (thread === undefined) return;
    const { messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
      messageRunIds: [run.id],
      messageRoles: ["assistant"],
    });
    const reply = messages.findLast(
      (message) => message.runId === run.id && message.role === "assistant",
    );
    const createdAt = DateTime.formatIso(run.completedAt ?? (yield* DateTime.now));
    yield* Effect.promise(() =>
      publishTurnCompletionNotification({
        threadId,
        turnId: run.id,
        project: thread.project,
        threadTitle: thread.shell.title,
        provider: run.providerInstanceId,
        state,
        text: reply?.text ?? "",
        errorMessage: state === "completed" ? undefined : (thread.shell.lastError ?? undefined),
        createdAt,
      }),
    );
  });

  const onRequest = Effect.fnUntraced(function* (
    threadId: ThreadId,
    request: OrchestrationV2RuntimeRequest,
  ) {
    const kind = attentionKind(request);
    if (kind === undefined || resolveMsgHubAttentionConfig(kind) === null) return;
    const thread = yield* describeThread(threadId);
    if (thread === undefined) return;
    const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"], {
      turnItemTypes: ["user_input_request", "approval_request"],
    });
    const item = turnItems.find(
      (candidate) =>
        (candidate.type === "user_input_request" || candidate.type === "approval_request") &&
        candidate.requestId === request.id,
    );
    const text =
      item?.type === "user_input_request"
        ? item.questions.map((question) => question.question).join("\n")
        : item?.type === "approval_request"
          ? (item.prompt ?? item.title ?? "")
          : "";
    yield* Effect.promise(() =>
      publishAttentionNotification({
        kind,
        eventId: `${threadId}:${request.id}`,
        requestId: request.id,
        threadId,
        project: thread.project,
        threadTitle: thread.shell.title,
        provider: thread.shell.providerInstanceId ?? "provider",
        text,
        createdAt: DateTime.formatIso(request.createdAt),
      }),
    );
  });

  const handle = (event: OrchestrationV2DomainEvent) =>
    (event.type === "run.updated"
      ? onRun(event.threadId, event.payload)
      : event.type === "runtime-request.updated"
        ? onRequest(event.threadId, event.payload)
        : Effect.void
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("msghub notification failed", { eventType: event.type, cause }),
      ),
    );

  yield* forkParked(
    Stream.runForEach(engine.streamDomainEvents, handle).pipe(
      Effect.catchCause((cause) => Effect.logWarning("msghub notifications stopped", { cause })),
    ),
  );
});
