import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../../serverActivation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  AUTO_RETRY_OUTPUT_ITEM_TYPES,
  AUTO_RETRY_PROGRESS_ITEM_TYPES,
  canAutoRetry,
  failedBeforeAnyOutput,
  MAX_AUTO_RETRY_ATTEMPTS,
  retryLineage,
} from "./FailedRunAutoRetryPolicy.ts";

export { isTransientFailure, MAX_AUTO_RETRY_ATTEMPTS } from "./FailedRunAutoRetryPolicy.ts";
const MESSAGE_PREFIX = "auto-retry";
const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

export type AutoRetryOriginMessage = Pick<
  OrchestrationV2ConversationMessage,
  "id" | "text" | "attachments" | "context"
>;

/**
 * Fork: a run that failed before any output usually never reached the
 * provider's history (Kiro drops rejected prompts), so resend the message.
 */
function replayText(original: string, attempt: number): string {
  // A native slash command must stay the first token and must not gain prose.
  if (original.trimStart().startsWith("/")) return original;
  const note = `(Automatic retry ${attempt}/${MAX_AUTO_RETRY_ATTEMPTS}: the previous attempt failed before any reply, so the original message is sent again.)`;
  return original.trim().length === 0 ? note : `${original}\n\n${note}`;
}

/** The user message a retry of `runId` would replay, if it needs one. */
export function autoRetryOriginMessageId(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">,
  runId: OrchestrationV2Run["id"],
): OrchestrationV2Run["userMessageId"] | null {
  const run = projection.runs.find((candidate) => candidate.id === runId);
  if (run === undefined || !failedBeforeAnyOutput(run, projection.turnItems)) return null;
  const { originRunId } = retryLineage(run, projection.turnItems);
  return projection.runs.find((candidate) => candidate.id === originRunId)?.userMessageId ?? null;
}

export function autoRetryCommand(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "turnItems" | "runtimeRequests"
  >,
  runId: OrchestrationV2Run["id"],
  originMessage?: AutoRetryOriginMessage | null,
): OrchestrationV2Command | null {
  const { thread, runs } = projection;
  const run = runs.find((candidate) => candidate.id === runId);
  if (run === undefined || run.status !== "failed") return null;
  if (latestExecutedRun(runs)?.id !== run.id) return null;
  // An in-flight run means the user (or another worker) already moved on.
  if (runs.some((candidate) => ACTIVE_RUN_STATUSES.has(candidate.status))) return null;
  if (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled" ||
    projection.runtimeRequests.some((request) => request.status === "pending")
  )
    return null;
  if (
    !canAutoRetry(run, latestRootProviderFailure(run, projection.turnItems), projection.turnItems)
  )
    return null;
  const lineage = retryLineage(run, projection.turnItems);
  const attempt = lineage.attempt + 1;
  const identity = `${MESSAGE_PREFIX}:${attempt}:${lineage.originRunId}`;
  const originRun = runs.find((candidate) => candidate.id === lineage.originRunId);
  const replay =
    originMessage !== undefined &&
    originMessage !== null &&
    originRun !== undefined &&
    originMessage.id === originRun.userMessageId &&
    failedBeforeAnyOutput(run, projection.turnItems)
      ? originMessage
      : null;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(identity),
    messageId: MessageId.make(identity),
    threadId: thread.id,
    text:
      replay === null
        ? `Continue where you left off. (Automatic retry ${attempt}/${MAX_AUTO_RETRY_ATTEMPTS} after a transient provider error.)`
        : replayText(replay.text, attempt),
    ...(replay?.context === undefined ? {} : { context: replay.context }),
    attachments: replay === null ? [] : [...replay.attachments],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

/**
 * Settings → General → "Auto-retry failed threads". Watches every thread for a
 * run that ends failed on a transient provider error and continues it right
 * away: the provider usually recovers on the next request, and a wait only
 * gives the user time to race the retry by hand. Off by default; flipping the
 * switch takes effect on the next failure without a restart.
 */
export const startFailedRunAutoRetry = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;

  const enabled = settings.getSettings.pipe(
    Effect.map((preferences) => preferences.autoRetryFailedThreads),
  );

  const evaluate = Effect.fnUntraced(function* (
    threadId: ThreadId,
    runId: OrchestrationV2Run["id"],
  ) {
    const projection = yield* projections.getThreadRecords(
      threadId,
      ["runs", "turnItems", "runtimeRequests"],
      {
        turnItemTypes: [
          "error",
          ...AUTO_RETRY_PROGRESS_ITEM_TYPES,
          ...AUTO_RETRY_OUTPUT_ITEM_TYPES,
        ],
        turnItemRunIds: [runId],
      },
    );
    const originMessageId = autoRetryOriginMessageId(projection, runId);
    const originMessage =
      originMessageId === null
        ? null
        : ((yield* projections.getThreadRecords(threadId, ["messages"], {
            messageIds: [originMessageId],
          })).messages.find(
            (message) => message.id === originMessageId && message.role === "user",
          ) ?? null);
    return autoRetryCommand(projection, runId, originMessage);
  });

  // A failed run can be re-published (checkpoint, title); keep one retry per run.
  const pending = new Set<string>();

  const retry = Effect.fnUntraced(function* (threadId: ThreadId, run: OrchestrationV2Run) {
    if (!(yield* enabled)) return;
    const command = yield* evaluate(threadId, run.id);
    if (command === null) return;
    yield* threads.dispatch(command);
    yield* Effect.logInfo("auto-retry dispatched", {
      threadId,
      failedRunId: run.id,
      commandId: command.commandId,
    });
  });

  yield* forkParked(
    Stream.runForEach(engine.streamDomainEvents, (event) =>
      event.type === "run.updated" &&
      event.payload.status === "failed" &&
      !pending.has(event.payload.id)
        ? Effect.sync(() => pending.add(event.payload.id)).pipe(
            Effect.andThen(retry(event.threadId, event.payload)),
            Effect.ensuring(Effect.sync(() => pending.delete(event.payload.id))),
            Effect.catchCause((cause) =>
              Effect.logWarning("auto-retry failed", { threadId: event.threadId, cause }),
            ),
            Effect.forkDetach,
            Effect.asVoid,
          )
        : Effect.void,
    ).pipe(Effect.catchCause((cause) => Effect.logWarning("auto-retry stopped", { cause }))),
  );
});
