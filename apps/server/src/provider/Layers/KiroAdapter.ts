/**
 * KiroAdapterLive — AWS Kiro CLI (`kiro-cli acp`) over ACP.
 *
 * The heavy lifting is in `AcpSessionRuntime`, which owns the JSON-RPC
 * connection, `initialize`, authentication, session create/load/resume, prompt
 * dispatch and the parsed event stream. This adapter is the translation layer:
 * T3's thread-shaped operations in, ACP calls out, plus the per-thread state
 * that ACP itself has no concept of (which turn is active, which approvals are
 * outstanding, whose prompt a later `cancel` should target).
 *
 * @module KiroAdapterLive
 */

import {
  ApprovalRequestId,
  EventId,
  type KiroSettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeKiroAcpRuntime } from "../acp/KiroAcpSupport.ts";

const PROVIDER = ProviderDriverKind.make("kiro");

export interface KiroAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Model selections are honored when `modelSelection.instanceId` matches this
   * value. Defaults to the built-in instance id (`kiro`).
   */
  readonly instanceId?: ProviderInstanceId;
  /**
   * Optional per-session settings resolver. Production leaves this undefined —
   * the hydration layer rebuilds the adapter when instance config changes, so
   * the captured settings are never stale. Tests that mutate settings
   * mid-flight (e.g. to point `binaryPath` at a mock ACP wrapper) pass a
   * resolver that reads the latest snapshot.
   */
  readonly resolveSettings?: Effect.Effect<KiroSettings>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface KiroSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  /**
   * Prompts currently in flight. >0 means a turn is actively running, so a new
   * `sendTurn` is a steer that continues it rather than a new turn, and only
   * the last remaining prompt settles the turn.
   */
  promptsInFlight: number;
  stopped: boolean;
}

export function makeKiroAdapter(kiroSettings: KiroSettings, options?: KiroAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("kiro");
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, KiroSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    /**
     * Serialize per thread, not globally: two threads must be able to start and
     * run concurrently, but a single thread's start / stop / send must not
     * interleave or the session map and the ACP child can disagree about which
     * session is live.
     */
    const withThreadLock = <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.gen(function* () {
        const semaphore = yield* SynchronizedRef.modifyEffect(threadLocksRef, (locks) =>
          Effect.gen(function* () {
            const existing = locks.get(threadId);
            if (existing) return [existing, locks] as const;
            const created = yield* Semaphore.make(1);
            const next = new Map(locks);
            next.set(threadId, created);
            return [created, next] as const;
          }),
        );
        return yield* semaphore.withPermits(1)(effect);
      });

    /**
     * Tear a session down.
     *
     * Order matters and is the reason this is one function rather than inline
     * cleanup: outstanding approvals and user-input requests are settled
     * FIRST, so anything awaiting them resumes with an explicit cancellation
     * instead of hanging until the scope's finalizers happen to run. Only then
     * is the scope closed (which kills the ACP child).
     */
    const stopSessionInternal = (ctx: KiroSessionContext): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;

        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        ctx.pendingApprovals.clear();
        ctx.pendingUserInputs.clear();

        // Closing the scope terminates the child, which ends the notification
        // stream on its own; interrupting the fiber first would race that.
        yield* Scope.close(ctx.scope, Exit.void);
        ctx.notificationFiber = undefined;
        ctx.activeTurnId = undefined;
        ctx.promptsInFlight = 0;
        sessions.delete(ctx.threadId);
      });

    const hasSession = (threadId: ThreadId): Effect.Effect<boolean> =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const listSessions = (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() =>
        Array.from(sessions.values())
          .filter((ctx) => !ctx.stopped)
          .map((ctx) => ctx.session),
      );

    const stopSession = (threadId: ThreadId): Effect.Effect<void> =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx) return;
          yield* stopSessionInternal(ctx);
        }),
      );

    /**
     * Stop every session. Deliberately does not take the per-thread locks: it
     * runs on shutdown, where a thread holding its lock on a hung prompt would
     * otherwise block teardown indefinitely.
     */
    const stopAll = (): Effect.Effect<void> =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    const streamEvents: Stream.Stream<ProviderRuntimeEvent> = Stream.fromPubSub(runtimeEventPubSub);

    const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    // `crypto.randomUUIDv4` is an Effect, not a method — it is combined, not
    // called. It can fail with a PlatformError, which must not propagate into
    // the event pump: a stamp is bookkeeping, and losing the whole event
    // stream because an id could not be generated would be a far worse
    // outcome than a fallback id.
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = crypto.randomUUIDv4.pipe(
      Effect.map((id) => EventId.make(id)),
      Effect.orDie,
    );
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    /**
     * Translate one ACP runtime event into T3's runtime events.
     *
     * Every branch is listed rather than defaulted: a new ACP event variant
     * should surface as a compile error here, not be silently dropped at
     * runtime where the symptom is "the UI stopped showing something".
     *
     * `turnId` comes from `ctx.activeTurnId` rather than the event, because ACP
     * has no turn concept — the adapter is the only thing that knows which T3
     * turn these deltas belong to.
     */
    const pumpAcpEvent = (
      ctx: KiroSessionContext,
      event: AcpSessionRuntime.AcpSessionRuntimeEvent,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        switch (event._tag) {
          case "EventStreamBarrier":
            // A barrier is a synchronisation point, not content: acknowledging
            // it is what lets the producer know this consumer has caught up.
            yield* Deferred.succeed(event.acknowledge, undefined).pipe(Effect.ignore);
            return;

          case "ConnectionTerminated":
            // The child died or the protocol broke. Settle everything waiting
            // on a decision so no caller is left hanging, then mark the session
            // dead — a later sendTurn must fail fast rather than write into a
            // closed pipe.
            yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
            ctx.pendingApprovals.clear();
            ctx.pendingUserInputs.clear();
            ctx.stopped = true;
            ctx.activeTurnId = undefined;
            ctx.promptsInFlight = 0;
            yield* Effect.logWarning("Kiro ACP connection terminated", {
              threadId: ctx.threadId,
              detail: event.error.message,
            });
            return;

          case "AssistantItemStarted":
            yield* offerRuntimeEvent(
              makeAcpAssistantItemEvent({
                stamp: yield* makeEventStamp(),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                itemId: event.itemId,
                lifecycle: "item.started",
              }),
            );
            return;

          case "AssistantItemCompleted":
            yield* offerRuntimeEvent(
              makeAcpAssistantItemEvent({
                stamp: yield* makeEventStamp(),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                itemId: event.itemId,
                lifecycle: "item.completed",
              }),
            );
            return;

          case "ContentDelta":
            yield* offerRuntimeEvent(
              makeAcpContentDeltaEvent({
                stamp: yield* makeEventStamp(),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                streamKind: "assistant_text",
                text: event.text,
                rawPayload: event.rawPayload,
              }),
            );
            return;

          case "ThoughtDelta":
            // Reasoning narration, not the answer. Kept on a separate stream
            // kind so a replayed turn shows the reply rather than the thinking.
            yield* offerRuntimeEvent(
              makeAcpContentDeltaEvent({
                stamp: yield* makeEventStamp(),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                streamKind: "reasoning_text",
                text: event.text,
                rawPayload: event.rawPayload,
              }),
            );
            return;

          case "ToolCallUpdated":
            yield* offerRuntimeEvent(
              makeAcpToolCallEvent({
                stamp: yield* makeEventStamp(),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                toolCall: event.toolCall,
                rawPayload: event.rawPayload,
              }),
            );
            return;

          case "PlanUpdated":
            yield* offerRuntimeEvent(
              makeAcpPlanUpdatedEvent({
                stamp: yield* makeEventStamp(),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                payload: event.payload,
                source: "acp.jsonrpc",
                method: "session/update",
                rawPayload: event.rawPayload,
              }),
            );
            return;

          case "ModeChanged":
          case "AvailableCommandsUpdated":
          case "ConfigOptionsUpdated":
            // Session-configuration echoes. The runtime already folds these
            // into its own mode/config state (`getModeState`,
            // `getConfigOptions`), and T3 reads them from there, so
            // re-emitting them as thread events would duplicate state with no
            // consumer.
            return;
        }
      });

    /** Look up a live session, or fail with the shape T3 expects. */
    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<KiroSessionContext, ProviderAdapterSessionNotFoundError> =>
      Effect.suspend(() => {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) {
          return Effect.fail(
            new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
          );
        }
        return Effect.succeed(ctx);
      });

    /**
     * Interrupt the active turn.
     *
     * `turnId` is advisory: when it names a turn that is not the active one the
     * call is a no-op rather than an error. A stale interrupt is normal —
     * the user hits stop just as the turn settles — and failing it would
     * surface a spurious error for something that already finished.
     *
     * Cancelling is fire-and-forget by protocol (`session/cancel` is an ACP
     * notification, not a request). The turn's own completion path is what
     * settles state; this only asks.
     */
    const interruptTurn = (
      threadId: ThreadId,
      turnId?: TurnId,
    ): Effect.Effect<void, ProviderAdapterSessionNotFoundError | ProviderAdapterProcessError> =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (turnId !== undefined && ctx.activeTurnId !== undefined && ctx.activeTurnId !== turnId) {
          return;
        }
        yield* ctx.acp.cancel.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );
      });

    /**
     * Answer an approval request the agent raised.
     *
     * The Deferred is removed from the map BEFORE being settled, so a double
     * response (two clicks, or a click racing session teardown) cannot settle
     * the same request twice. An unknown id resolves quietly: by the time a
     * user clicks, the request may already have been cancelled by teardown,
     * and that is not an error worth surfacing.
     */
    const respondToRequest = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterSessionNotFoundError> =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) return;
        ctx.pendingApprovals.delete(requestId);
        yield* Deferred.succeed(pending.decision, decision).pipe(Effect.ignore);
      });

    /** Same contract as respondToRequest, for structured user-input requests. */
    const respondToUserInput = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
    ): Effect.Effect<void, ProviderAdapterSessionNotFoundError> =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) return;
        ctx.pendingUserInputs.delete(requestId);
        yield* Deferred.succeed(pending.answers, answers).pipe(Effect.ignore);
      });

    /**
     * Return the turns this adapter has observed.
     *
     * This is the adapter's own record, not a query to kiro-cli: ACP has no
     * "read history" call, and kiro-cli's session store is its own business.
     * Items are copied out so a caller cannot mutate live session state.
     */
    const readThread = (
      threadId: ThreadId,
    ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterSessionNotFoundError> =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return {
          threadId,
          turns: ctx.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
        };
      });

    /**
     * Rejected, always.
     *
     * kiro-cli's ACP session cannot rewind its conversation, and
     * `capabilities.supportsConversationRollback` says so. T3's checkpoint
     * boundary is supposed to refuse revert before touching the filesystem, but
     * this second refusal is not redundant: if that check is ever bypassed,
     * failing here keeps the filesystem consistent with the provider
     * conversation instead of reverting files while the agent still believes
     * the old turn happened.
     */
    const rollbackThread = (
      threadId: ThreadId,
      numTurns: number,
    ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterValidationError> =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: `Kiro cannot roll back its conversation, so refusing to rewind ${numTurns} turn(s) on thread ${threadId}. Start a new thread instead.`,
        }),
      );

    return {
      provider: PROVIDER,
      capabilities: {
        // kiro-cli accepts a model id per prompt, so switching does not need a
        // new thread.
        sessionModelSwitch: "in-session" as const,
        // The ACP session cannot roll back its conversation. Declared honestly
        // so T3's checkpoint boundary rejects revert BEFORE touching files —
        // claiming otherwise would leave the filesystem reverted while the
        // provider still believes the old turn happened.
        supportsConversationRollback: false,
      },
      // `/compact` is kiro-cli's own context compaction command.
      compaction: { type: "slash-command" as const, command: "/compact" as const },
      hasSession,
      listSessions,
      stopSession,
      stopAll,
      streamEvents,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      readThread,
      rollbackThread,
    };
  });
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    { discard: true },
  );
}
