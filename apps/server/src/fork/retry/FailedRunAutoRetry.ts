import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../../serverActivation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { canAutoRetry, MAX_AUTO_RETRY_ATTEMPTS, retryLineage } from "./FailedRunAutoRetryPolicy.ts";

export { isTransientFailure, MAX_AUTO_RETRY_ATTEMPTS } from "./FailedRunAutoRetryPolicy.ts";
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000] as const;
const MESSAGE_PREFIX = "auto-retry";
const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

export function autoRetryCommand(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "turnItems" | "runtimeRequests"
  >,
  runId: OrchestrationV2Run["id"],
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
  if (!canAutoRetry(run, latestRootProviderFailure(run, projection.turnItems))) return null;
  const lineage = retryLineage(run);
  const attempt = lineage.attempt + 1;
  const identity = `${MESSAGE_PREFIX}:${attempt}:${lineage.originRunId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(identity),
    messageId: MessageId.make(identity),
    threadId: thread.id,
    text: `Continue where you left off. (Automatic retry ${attempt}/${MAX_AUTO_RETRY_ATTEMPTS} after a transient provider error.)`,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

export function retryDelayMs(run: Pick<OrchestrationV2Run, "id" | "userMessageId">): number {
  const { attempt } = retryLineage(run);
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!;
}

/**
 * Settings → General → "Auto-retry failed threads". Watches every thread for a
 * run that ends failed on a transient provider error, waits a short backoff,
 * re-checks that nothing else happened on the thread, then sends a
 * continuation. Off by default; flipping the switch takes effect on the next
 * failure without a restart.
 */
export const startFailedRunAutoRetry = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;

  const enabled = settings.getSettings.pipe(
    Effect.map((preferences) => preferences.autoRetryFailedThreads),
  );

  const evaluate = (threadId: ThreadId, runId: OrchestrationV2Run["id"]) =>
    projections
      .getThreadRecords(threadId, ["runs", "turnItems", "runtimeRequests"], {
        turnItemTypes: ["error"],
        turnItemRunIds: [runId],
      })
      .pipe(Effect.map((projection) => autoRetryCommand(projection, runId)));

  // A failed run can be re-published (checkpoint, title); keep one timer per run.
  const pending = new Set<string>();

  const retry = Effect.fnUntraced(function* (threadId: ThreadId, run: OrchestrationV2Run) {
    if (!(yield* enabled)) return;
    if ((yield* evaluate(threadId, run.id)) === null) return;
    yield* Effect.sleep(Duration.millis(retryDelayMs(run)));
    // The user may have replied, stopped the thread, or turned the switch off meanwhile.
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
