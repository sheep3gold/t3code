/**
 * `thread_ledger_*` MCP tools on the upstream base.
 *
 * Same tools and same tool names the V1 fork shipped, so threads and agents
 * that call them keep working. The thread check moves to the V2 projection
 * store; everything else is unchanged.
 *
 * @module fork/ledger/ThreadLedgerToolkit
 */
import { OrchestratorMcpFailure, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLedgerPersistence from "./ThreadLedger.ts";

const MAX_FIELD_CHARS = 2_000;
const MAX_ARTIFACTS = 32;
const MAX_LEDGER_CONTEXT_CHARS = 6_000;
const CONTEXT_EVENT_LIMIT = 8;

const LedgerState = Schema.Struct({
  goal: Schema.NullOr(Schema.String),
  phase: Schema.NullOr(Schema.String),
  next: Schema.NullOr(Schema.String),
  artifacts: Schema.Record(Schema.String, Schema.String),
  updatedAt: Schema.String,
});

const LedgerEvent = Schema.Struct({
  id: Schema.Number,
  kind: Schema.String,
  message: Schema.String,
  createdAt: Schema.String,
});

const LedgerSnapshot = Schema.Struct({
  state: Schema.NullOr(LedgerState),
  events: Schema.Array(LedgerEvent),
});

const RecordLedgerInput = Schema.Struct({
  goal: Schema.optional(Schema.NullOr(Schema.String)),
  phase: Schema.optional(Schema.NullOr(Schema.String)),
  next: Schema.optional(Schema.NullOr(Schema.String)),
  artifacts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  eventKind: Schema.optional(TrimmedNonEmptyString),
  event: Schema.optional(TrimmedNonEmptyString),
});

export class ThreadLedgerInputInvalidError extends Schema.TaggedError<ThreadLedgerInputInvalidError>()(
  "ThreadLedgerInputInvalidError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class ThreadLedgerThreadNotFoundError extends Schema.TaggedError<ThreadLedgerThreadNotFoundError>()(
  "ThreadLedgerThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class ThreadLedgerOperationError extends Schema.TaggedError<ThreadLedgerOperationError>()(
  "ThreadLedgerOperationError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Thread ledger operation '${this.operation}' failed.`;
  }
}

const ThreadLedgerToolError = Schema.Union([
  OrchestratorMcpFailure,
  ThreadLedgerInputInvalidError,
  ThreadLedgerThreadNotFoundError,
  ThreadLedgerOperationError,
]);

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadLedgerPersistence.ThreadLedgerRepository,
  ProjectionStore.ProjectionStoreV2,
  ThreadManagementService.ThreadManagementService,
  Clock.Clock,
];

const ReadThreadLedgerTool = Tool.make("thread_ledger_read", {
  description:
    "Read this thread's durable work ledger: its goal, phase, next step, artifact pointers, and recent progress events.",
  success: LedgerSnapshot,
  failure: ThreadLedgerToolError,
  failureMode: "return" as const,
  dependencies,
})
  .annotate(Tool.Title, "Read thread ledger")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RecordThreadLedgerTool = Tool.make("thread_ledger_record", {
  description:
    "Update this thread's durable work ledger. Omitted state fields retain their current values; null clears one. Changing phase requires eventKind and event in the same call. Use next for a concrete resumable action, not a status word.",
  parameters: RecordLedgerInput,
  success: LedgerSnapshot,
  failure: ThreadLedgerToolError,
  failureMode: "return" as const,
  dependencies,
})
  .annotate(Tool.Title, "Record thread ledger")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ThreadLedgerToolkit = Toolkit.make(ReadThreadLedgerTool, RecordThreadLedgerTool);

function clipped(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return value;
  const normalized = value.trim();
  return Array.from(normalized).slice(0, MAX_FIELD_CHARS).join("");
}

function validateArtifacts(
  artifacts: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | null {
  const entries = Object.entries(artifacts);
  if (entries.length > MAX_ARTIFACTS) return null;
  const normalized: Record<string, string> = {};
  for (const [key, value] of entries) {
    const normalizedKey = clipped(key);
    const normalizedValue = clipped(value);
    if (!normalizedKey || !normalizedValue) return null;
    normalized[normalizedKey] = normalizedValue;
  }
  return normalized;
}

export function formatThreadLedgerContext(
  snapshot: ThreadLedgerPersistence.ThreadLedgerSnapshot,
): string {
  if (snapshot.state === null) return "";
  const state = snapshot.state;
  const lines = [
    "[Persistent thread ledger — durable resume state]",
    ...(state.goal ? [`Goal: ${state.goal}`] : []),
    ...(state.phase ? [`Phase: ${state.phase}`] : []),
    ...(state.next ? [`Next: ${state.next}`] : []),
    ...Object.entries(state.artifacts).map(([key, value]) => `Artifact ${key}: ${value}`),
    ...(snapshot.events.length > 0
      ? [
          "Recent events:",
          ...snapshot.events
            .slice(-CONTEXT_EVENT_LIMIT)
            .map((event) => `- ${event.createdAt} [${event.kind}] ${event.message}`),
        ]
      : []),
    "[End persistent thread ledger]",
  ];
  return Array.from(lines.join("\n")).slice(0, MAX_LEDGER_CONTEXT_CHARS).join("");
}

/** Resolves the calling thread, rejecting archived and deleted threads. */
const callerContext = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threadScope = yield* McpInvocationContext.requireThreadScope(scope, "Thread ledger");
  const threadId = ThreadId.make(threadScope.thread.threadId);
  const shell = yield* (yield* ProjectionStore.ProjectionStoreV2)
    .getThreadShell(threadId)
    .pipe(
      Effect.mapError(
        (cause) => new ThreadLedgerOperationError({ operation: "read-thread", cause }),
      ),
    );
  if (shell === null || shell.archivedAt !== null || shell.deletedAt !== null) {
    return yield* new ThreadLedgerThreadNotFoundError({ threadId });
  }
  return { threadId };
});

const repositoryError = (operation: string) => (cause: unknown) =>
  new ThreadLedgerOperationError({ operation, cause: cause as never });

export const ThreadLedgerHandlersLive = McpToolAccess.toLayer(ThreadLedgerToolkit, {
  thread_ledger_read: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const context = yield* callerContext;
      return yield* (yield* ThreadLedgerPersistence.ThreadLedgerRepository)
        .read(context.threadId)
        .pipe(Effect.mapError(repositoryError("read")));
    }),
  ),
  thread_ledger_record: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const context = yield* callerContext;
      const repository = yield* ThreadLedgerPersistence.ThreadLedgerRepository;
      const current = yield* repository
        .read(context.threadId)
        .pipe(Effect.mapError(repositoryError("read")));
      const currentState = current.state ?? {
        goal: null,
        phase: null,
        next: null,
        artifacts: {},
      };
      const phase = input.phase === undefined ? currentState.phase : clipped(input.phase);
      const phaseChanged = phase !== currentState.phase;
      const hasEvent = input.event !== undefined || input.eventKind !== undefined;
      if (phaseChanged && (input.event === undefined || input.eventKind === undefined)) {
        return yield* new ThreadLedgerInputInvalidError({
          detail: "Changing phase requires both eventKind and event.",
        });
      }
      if (hasEvent && (input.event === undefined || input.eventKind === undefined)) {
        return yield* new ThreadLedgerInputInvalidError({
          detail: "eventKind and event must be supplied together.",
        });
      }
      const artifacts =
        input.artifacts === undefined ? currentState.artifacts : validateArtifacts(input.artifacts);
      if (artifacts === null) {
        return yield* new ThreadLedgerInputInvalidError({
          detail: `artifacts must contain at most ${MAX_ARTIFACTS} non-empty string entries.`,
        });
      }
      if (
        input.goal === undefined &&
        input.phase === undefined &&
        input.next === undefined &&
        input.artifacts === undefined &&
        !hasEvent
      ) {
        return yield* new ThreadLedgerInputInvalidError({ detail: "No ledger change supplied." });
      }
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      const eventKind = clipped(input.eventKind);
      const eventMessage = clipped(input.event);
      return yield* repository
        .record({
          threadId: context.threadId,
          state: {
            goal: input.goal === undefined ? currentState.goal : (clipped(input.goal) ?? null),
            phase: phase ?? null,
            next: input.next === undefined ? currentState.next : (clipped(input.next) ?? null),
            artifacts,
          },
          updatedAt,
          ...(eventKind !== undefined &&
          eventMessage !== undefined &&
          eventKind !== null &&
          eventMessage !== null
            ? { event: { kind: eventKind, message: eventMessage } }
            : {}),
        })
        .pipe(Effect.mapError(repositoryError("record")));
    }),
  ),
});

export const readThreadLedgerContext = Effect.fn("ThreadLedger.readContext")(function* (
  threadId: ThreadId,
) {
  const repository = yield* ThreadLedgerPersistence.ThreadLedgerRepository;
  const snapshot = yield* repository.read(threadId, CONTEXT_EVENT_LIMIT);
  return formatThreadLedgerContext(snapshot);
});
