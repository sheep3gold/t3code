import {
  CommandId,
  MessageId,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as ThreadSchedules from "../persistence/ThreadSchedules.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

const MIN_DELAY_SECONDS = 15;
const MIN_INTERVAL_SECONDS = 60;
const MAX_PROMPT_CHARS = 20_000;
const BUSY_DEFER_MS = 60_000;
const FAILED_DEFER_MS = 60_000;
const SWEEP_INTERVAL = "15 seconds";

const ScheduleThreadTaskInput = Schema.Struct({
  prompt: TrimmedNonEmptyString,
  at: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "ISO-8601 date/time for a one-shot task. Mutually exclusive with delaySeconds and everySeconds.",
    }),
  ),
  delaySeconds: Schema.optional(
    PositiveInt.annotate({
      description: "Seconds from now for a one-shot task. Minimum 15 seconds.",
    }),
  ),
  everySeconds: Schema.optional(
    PositiveInt.annotate({
      description: "Recurring interval in seconds. Minimum 60 seconds.",
    }),
  ),
});

const ScheduleIdInput = Schema.Struct({ scheduleId: TrimmedNonEmptyString });

const ThreadScheduleResult = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  scheduleKind: Schema.Literals(["once", "interval"]),
  intervalSeconds: Schema.NullOr(Schema.Number),
  nextRunAt: Schema.String,
  status: Schema.Literals(["active", "paused", "completed"]),
  lastRunAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const ScheduleMutationResult = Schema.Struct({ changed: Schema.Boolean });

export class ThreadScheduleInputInvalidError extends Schema.TaggedError<ThreadScheduleInputInvalidError>()(
  "ThreadScheduleInputInvalidError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class ThreadScheduleThreadNotFoundError extends Schema.TaggedError<ThreadScheduleThreadNotFoundError>()(
  "ThreadScheduleThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class ThreadScheduleOperationError extends Schema.TaggedError<ThreadScheduleOperationError>()(
  "ThreadScheduleOperationError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Thread schedule operation '${this.operation}' failed.`;
  }
}

const ThreadScheduleToolError = Schema.Union([
  ThreadScheduleInputInvalidError,
  ThreadScheduleThreadNotFoundError,
  ThreadScheduleOperationError,
]);

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadSchedules.ThreadScheduleRepository,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  Crypto.Crypto,
  Clock.Clock,
];

const ScheduleThreadTaskTool = Tool.make("schedule_thread_task", {
  description:
    "Schedule this thread to run an agent prompt once or repeatedly. Pass exactly one of at, delaySeconds, or everySeconds. The schedule persists across server restarts and never overlaps an active turn or pending approval/question.",
  parameters: ScheduleThreadTaskInput,
  success: ThreadScheduleResult,
  failure: ThreadScheduleToolError,
  dependencies,
})
  .annotate(Tool.Title, "Schedule thread task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ListThreadSchedulesTool = Tool.make("list_thread_schedules", {
  description: "List schedules owned by this thread, including paused and completed one-shot tasks.",
  success: Schema.Struct({ schedules: Schema.Array(ThreadScheduleResult) }),
  failure: ThreadScheduleToolError,
  dependencies,
})
  .annotate(Tool.Title, "List thread schedules")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PauseThreadScheduleTool = Tool.make("pause_thread_schedule", {
  description: "Pause an active schedule owned by this thread.",
  parameters: ScheduleIdInput,
  success: ScheduleMutationResult,
  failure: ThreadScheduleToolError,
  dependencies,
})
  .annotate(Tool.Title, "Pause thread schedule")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ResumeThreadScheduleTool = Tool.make("resume_thread_schedule", {
  description: "Resume a paused schedule owned by this thread. A past due time runs on the next sweep.",
  parameters: ScheduleIdInput,
  success: ScheduleMutationResult,
  failure: ThreadScheduleToolError,
  dependencies,
})
  .annotate(Tool.Title, "Resume thread schedule")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DeleteThreadScheduleTool = Tool.make("delete_thread_schedule", {
  description: "Permanently delete a schedule owned by this thread.",
  parameters: ScheduleIdInput,
  success: ScheduleMutationResult,
  failure: ThreadScheduleToolError,
  dependencies,
})
  .annotate(Tool.Title, "Delete thread schedule")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadScheduleToolkit = Toolkit.make(
  ScheduleThreadTaskTool,
  ListThreadSchedulesTool,
  PauseThreadScheduleTool,
  ResumeThreadScheduleTool,
  DeleteThreadScheduleTool,
);

function publicSchedule(schedule: ThreadSchedules.ThreadSchedule) {
  const { threadId: _threadId, ...result } = schedule;
  return result;
}

export function resolveThreadSchedule(input: {
  readonly nowMs: number;
  readonly at?: string;
  readonly delaySeconds?: number;
  readonly everySeconds?: number;
}):
  | {
      readonly scheduleKind: ThreadSchedules.ThreadScheduleKind;
      readonly intervalSeconds: number | null;
      readonly nextRunAt: string;
    }
  | { readonly error: string } {
  const supplied = [input.at, input.delaySeconds, input.everySeconds].filter(
    (value) => value !== undefined,
  ).length;
  if (supplied !== 1) return { error: "Pass exactly one of at, delaySeconds, or everySeconds." };
  if (input.everySeconds !== undefined) {
    if (input.everySeconds < MIN_INTERVAL_SECONDS) {
      return { error: `everySeconds must be at least ${MIN_INTERVAL_SECONDS}.` };
    }
    return {
      scheduleKind: "interval",
      intervalSeconds: input.everySeconds,
      nextRunAt: new Date(input.nowMs + input.everySeconds * 1_000).toISOString(),
    };
  }
  if (input.delaySeconds !== undefined) {
    if (input.delaySeconds < MIN_DELAY_SECONDS) {
      return { error: `delaySeconds must be at least ${MIN_DELAY_SECONDS}.` };
    }
    return {
      scheduleKind: "once",
      intervalSeconds: null,
      nextRunAt: new Date(input.nowMs + input.delaySeconds * 1_000).toISOString(),
    };
  }
  const atMs = Date.parse(input.at!);
  if (!Number.isFinite(atMs) || atMs <= input.nowMs) {
    return { error: "at must be a valid future ISO-8601 date/time." };
  }
  return {
    scheduleKind: "once",
    intervalSeconds: null,
    nextRunAt: new Date(atMs).toISOString(),
  };
}

export function nextThreadScheduleRun(
  schedule: Pick<ThreadSchedules.ThreadSchedule, "scheduleKind" | "intervalSeconds" | "nextRunAt">,
  nowMs: number,
): string | null {
  if (schedule.scheduleKind === "once" || schedule.intervalSeconds === null) return null;
  const intervalMs = schedule.intervalSeconds * 1_000;
  const plannedMs = Date.parse(schedule.nextRunAt);
  const elapsedIntervals = Math.max(1, Math.floor((nowMs - plannedMs) / intervalMs) + 1);
  return new Date(plannedMs + elapsedIntervals * intervalMs).toISOString();
}

const makeToolkit = Effect.gen(function* () {
  const repository = yield* ThreadSchedules.ThreadScheduleRepository;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const withError = (operation: string) =>
    Effect.mapError((cause: unknown) => new ThreadScheduleOperationError({ operation, cause }));

  const currentScope = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const thread = yield* snapshots.getThreadShellById(scope.threadId).pipe(withError("read-thread"));
    if (Option.isNone(thread) || thread.value.archivedAt !== null || thread.value.deletedAt !== null) {
      return yield* new ThreadScheduleThreadNotFoundError({ threadId: scope.threadId });
    }
    return scope;
  });

  const mutate = Effect.fn("ThreadSchedules.mutate")(function* (
    operation: "pause" | "resume" | "delete",
    scheduleId: string,
  ) {
    const scope = yield* currentScope;
    const now = new Date(yield* Clock.currentTimeMillis).toISOString();
    const changed = yield* (operation === "delete"
      ? repository.remove(scheduleId, scope.threadId)
      : repository.setPaused(scheduleId, scope.threadId, operation === "pause", now)
    ).pipe(withError(operation));
    return { changed };
  });

  return ThreadScheduleToolkit.of({
    schedule_thread_task: (input) =>
      Effect.gen(function* () {
        const scope = yield* currentScope;
        if (Array.from(input.prompt).length > MAX_PROMPT_CHARS) {
          return yield* new ThreadScheduleInputInvalidError({
            detail: `prompt must be at most ${MAX_PROMPT_CHARS} characters.`,
          });
        }
        const nowMs = yield* Clock.currentTimeMillis;
        const resolved = resolveThreadSchedule({ nowMs, ...input });
        if ("error" in resolved) {
          return yield* new ThreadScheduleInputInvalidError({ detail: resolved.error });
        }
        const createdAt = new Date(nowMs).toISOString();
        const schedule = yield* repository
          .create({
            id: yield* crypto.randomUUIDv4,
            threadId: scope.threadId,
            prompt: input.prompt,
            ...resolved,
            createdAt,
          })
          .pipe(withError("create"));
        return publicSchedule(schedule);
      }),
    list_thread_schedules: () =>
      Effect.gen(function* () {
        const scope = yield* currentScope;
        const schedules = yield* repository.list(scope.threadId).pipe(withError("list"));
        return { schedules: schedules.map(publicSchedule) };
      }),
    pause_thread_schedule: ({ scheduleId }) => mutate("pause", scheduleId),
    resume_thread_schedule: ({ scheduleId }) => mutate("resume", scheduleId),
    delete_thread_schedule: ({ scheduleId }) => mutate("delete", scheduleId),
  });
});

export const ThreadScheduleToolkitHandlersLive = ThreadScheduleToolkit.toLayer(makeToolkit);

const runner = Effect.gen(function* () {
  const repository = yield* ThreadSchedules.ThreadScheduleRepository;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;

  const sweep = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const now = new Date(nowMs).toISOString();
    const due = yield* repository.listDue(now);
    for (const schedule of due) {
      const thread = yield* snapshots
        .getThreadShellById(schedule.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (!thread || thread.archivedAt !== null || thread.deletedAt !== null) {
        yield* repository.setPaused(schedule.id, schedule.threadId, true, now);
        continue;
      }
      const blocked =
        thread.session?.activeTurnId !== null && thread.session?.activeTurnId !== undefined ||
        thread.session?.status === "starting" ||
        thread.session?.status === "running" ||
        thread.hasPendingApprovals ||
        thread.hasPendingUserInput;
      if (blocked) {
        yield* repository.defer(
          schedule.id,
          schedule.nextRunAt,
          new Date(nowMs + BUSY_DEFER_MS).toISOString(),
          now,
        );
        continue;
      }
      const dispatchKey = `${schedule.id}:${schedule.nextRunAt}`;
      const result = yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`schedule:${dispatchKey}`),
          threadId: schedule.threadId,
          message: {
            messageId: MessageId.make(`schedule:${dispatchKey}`),
            role: "user",
            text: `[Scheduled task ${schedule.id}]\n\n${schedule.prompt}`,
            attachments: [],
          },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: now,
        })
        .pipe(Effect.either);
      if (result._tag === "Left") {
        yield* repository.defer(
          schedule.id,
          schedule.nextRunAt,
          new Date(nowMs + FAILED_DEFER_MS).toISOString(),
          now,
        );
        yield* Effect.logWarning("thread schedule dispatch failed", {
          scheduleId: schedule.id,
          threadId: schedule.threadId,
          cause: result.left,
        });
        continue;
      }
      yield* repository.recordRun(schedule, now, nextThreadScheduleRun(schedule, nowMs));
      yield* Effect.logInfo("thread schedule dispatched", {
        scheduleId: schedule.id,
        threadId: schedule.threadId,
        scheduleKind: schedule.scheduleKind,
      });
    }
  });

  yield* forkParked(
    sweep.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("thread schedule sweep failed", { cause }),
      ),
      Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
    ),
  );
});

export const startThreadScheduleRunner = runner;
