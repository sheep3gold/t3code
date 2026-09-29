// @effect-diagnostics globalDate:off -- schedule math works on Clock epoch millis and IANA timezones via Intl.
// @effect-diagnostics globalDateInEffect:off -- same epoch-millis values, formatted for persisted ISO columns.
import { CommandId, MessageId, PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Cron from "effect/Cron";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
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
      description:
        "ISO-8601 date/time for a one-shot task. Mutually exclusive with delaySeconds and everySeconds.",
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
  cronExpression: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Five-field cron expression. Mutually exclusive with at, delaySeconds, and everySeconds.",
    }),
  ),
  timezone: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "IANA timezone for cronExpression, such as Asia/Shanghai. Defaults to UTC.",
    }),
  ),
  skipDates: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).annotate({
      description: "Local YYYY-MM-DD dates to skip. Valid only with cronExpression.",
    }),
  ),
});

const ScheduleIdInput = Schema.Struct({ scheduleId: TrimmedNonEmptyString });

const ThreadScheduleResult = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  scheduleKind: Schema.Literals(["once", "interval", "cron"]),
  intervalSeconds: Schema.NullOr(Schema.Number),
  cronExpression: Schema.NullOr(Schema.String),
  timezone: Schema.NullOr(Schema.String),
  skipDates: Schema.Array(Schema.String),
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
    "Schedule this thread to run an agent prompt once, on a fixed interval, or from a five-field cron expression. Pass exactly one of at, delaySeconds, everySeconds, or cronExpression. Cron schedules accept an IANA timezone and local skip dates. The schedule persists across server restarts and never overlaps an active turn or pending approval/question.",
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
  description:
    "List schedules owned by this thread, including paused and completed one-shot tasks.",
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
  description:
    "Resume a paused schedule owned by this thread. A past due time runs on the next sweep.",
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

const MAX_SKIP_DATES = 366;

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function localDateKey(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function nextCronRun(
  cron: Cron.Cron,
  timezone: string,
  skipDates: ReadonlyArray<string>,
  afterMs: number,
): string | null {
  const skipped = new Set(skipDates);
  let cursor = new Date(afterMs);
  try {
    for (let attempt = 0; attempt <= MAX_SKIP_DATES; attempt += 1) {
      const candidate = Cron.next(cron, cursor);
      if (!skipped.has(localDateKey(candidate, timezone))) return candidate.toISOString();
      cursor = candidate;
    }
  } catch {
    return null;
  }
  return null;
}

export function resolveThreadSchedule(input: {
  readonly nowMs: number;
  readonly at?: string | undefined;
  readonly delaySeconds?: number | undefined;
  readonly everySeconds?: number | undefined;
  readonly cronExpression?: string | undefined;
  readonly timezone?: string | undefined;
  readonly skipDates?: ReadonlyArray<string> | undefined;
}):
  | Pick<
      ThreadSchedules.CreateThreadScheduleInput,
      "scheduleKind" | "intervalSeconds" | "cronExpression" | "timezone" | "skipDates" | "nextRunAt"
    >
  | { readonly error: string } {
  const supplied = [input.at, input.delaySeconds, input.everySeconds, input.cronExpression].filter(
    (value) => value !== undefined,
  ).length;
  if (supplied !== 1) {
    return { error: "Pass exactly one of at, delaySeconds, everySeconds, or cronExpression." };
  }
  if (
    input.cronExpression === undefined &&
    (input.timezone !== undefined || input.skipDates !== undefined)
  ) {
    return { error: "timezone and skipDates are only valid with cronExpression." };
  }
  if (input.everySeconds !== undefined) {
    if (input.everySeconds < MIN_INTERVAL_SECONDS) {
      return { error: `everySeconds must be at least ${MIN_INTERVAL_SECONDS}.` };
    }
    return {
      scheduleKind: "interval",
      intervalSeconds: input.everySeconds,
      cronExpression: null,
      timezone: null,
      skipDates: [],
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
      cronExpression: null,
      timezone: null,
      skipDates: [],
      nextRunAt: new Date(input.nowMs + input.delaySeconds * 1_000).toISOString(),
    };
  }
  if (input.cronExpression !== undefined) {
    const cronExpression = input.cronExpression.trim();
    if (cronExpression.split(/\s+/).length !== 5) {
      return { error: "cronExpression must contain exactly five fields." };
    }
    const timezone = input.timezone?.trim() || "UTC";
    const skipDates = [...new Set(input.skipDates ?? [])].sort();
    if (skipDates.length > MAX_SKIP_DATES || skipDates.some((value) => !isCalendarDate(value))) {
      return { error: `skipDates must contain at most ${MAX_SKIP_DATES} valid YYYY-MM-DD dates.` };
    }
    const parsed = Cron.parse(cronExpression, timezone);
    if (Result.isFailure(parsed)) return { error: parsed.failure.message };
    const nextRunAt = nextCronRun(parsed.success, timezone, skipDates, input.nowMs);
    if (nextRunAt === null) return { error: "cronExpression has no runnable future occurrence." };
    return {
      scheduleKind: "cron",
      intervalSeconds: null,
      cronExpression,
      timezone,
      skipDates,
      nextRunAt,
    };
  }
  const atMs = Date.parse(input.at!);
  if (!Number.isFinite(atMs) || atMs <= input.nowMs) {
    return { error: "at must be a valid future ISO-8601 date/time." };
  }
  return {
    scheduleKind: "once",
    intervalSeconds: null,
    cronExpression: null,
    timezone: null,
    skipDates: [],
    nextRunAt: new Date(atMs).toISOString(),
  };
}

export function nextThreadScheduleRun(
  schedule: Pick<
    ThreadSchedules.ThreadSchedule,
    "scheduleKind" | "intervalSeconds" | "cronExpression" | "timezone" | "skipDates" | "nextRunAt"
  >,
  nowMs: number,
): string | null {
  if (schedule.scheduleKind === "once") return null;
  if (schedule.scheduleKind === "cron") {
    if (schedule.cronExpression === null || schedule.timezone === null) return null;
    const parsed = Cron.parse(schedule.cronExpression, schedule.timezone);
    return Result.isFailure(parsed)
      ? null
      : nextCronRun(parsed.success, schedule.timezone, schedule.skipDates, nowMs);
  }
  if (schedule.intervalSeconds === null) return null;
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
    const thread = yield* snapshots
      .getThreadShellById(scope.threadId)
      .pipe(withError("read-thread"));
    if (Option.isNone(thread) || thread.value.archivedAt !== null) {
      return yield* new ThreadScheduleThreadNotFoundError({ threadId: scope.threadId });
    }
    return scope;
  });

  const mutate = Effect.fn("ThreadSchedules.mutate")(function* (
    operation: "pause" | "resume" | "delete",
    scheduleId: string,
  ) {
    const scope = yield* currentScope;
    const now = DateTime.formatIso(yield* DateTime.now);
    const changed = yield* (
      operation === "delete"
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
            id: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
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
      if (
        schedule.scheduleKind === "cron" &&
        schedule.timezone !== null &&
        schedule.skipDates.includes(localDateKey(new Date(nowMs), schedule.timezone))
      ) {
        const nextRunAt = nextThreadScheduleRun(schedule, nowMs);
        if (nextRunAt === null) {
          yield* repository.setPaused(schedule.id, schedule.threadId, true, now);
        } else {
          yield* repository.defer(schedule.id, schedule.nextRunAt, nextRunAt, now);
        }
        continue;
      }
      const thread = yield* snapshots
        .getThreadShellById(schedule.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (!thread || thread.archivedAt !== null) {
        yield* repository.setPaused(schedule.id, schedule.threadId, true, now);
        continue;
      }
      const blocked =
        (thread.session?.activeTurnId !== null && thread.session?.activeTurnId !== undefined) ||
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
        .pipe(Effect.result);
      if (Result.isFailure(result)) {
        yield* repository.defer(
          schedule.id,
          schedule.nextRunAt,
          new Date(nowMs + FAILED_DEFER_MS).toISOString(),
          now,
        );
        yield* Effect.logWarning("thread schedule dispatch failed", {
          scheduleId: schedule.id,
          threadId: schedule.threadId,
          cause: result.failure,
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
      Effect.catchCause((cause) => Effect.logWarning("thread schedule sweep failed", { cause })),
      Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
    ),
  );
});

export const startThreadScheduleRunner = runner;
