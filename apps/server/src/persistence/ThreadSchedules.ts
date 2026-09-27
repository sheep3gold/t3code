// @effect-diagnostics preferSchemaOverJson:off -- *_json columns hold plain string arrays/records written inside SQL templates.
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError } from "./Errors.ts";

export type ThreadScheduleKind = "once" | "interval" | "cron";
export type ThreadScheduleStatus = "active" | "paused" | "completed";

export interface ThreadSchedule {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly prompt: string;
  readonly scheduleKind: ThreadScheduleKind;
  readonly intervalSeconds: number | null;
  readonly cronExpression: string | null;
  readonly timezone: string | null;
  readonly skipDates: ReadonlyArray<string>;
  readonly nextRunAt: string;
  readonly status: ThreadScheduleStatus;
  readonly lastRunAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ThreadScheduleRow {
  readonly id: string;
  readonly threadId: string;
  readonly prompt: string;
  readonly scheduleKind: ThreadScheduleKind;
  readonly intervalSeconds: number | null;
  readonly cronExpression: string | null;
  readonly timezone: string | null;
  readonly skipDatesJson: string;
  readonly nextRunAt: string;
  readonly status: ThreadScheduleStatus;
  readonly lastRunAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectThreadSchedule extends ThreadSchedule {
  readonly projectId: ProjectId;
  readonly threadTitle: string;
}

interface ProjectThreadScheduleRow extends ThreadScheduleRow {
  readonly projectId: string;
  readonly threadTitle: string;
}

export interface CreateThreadScheduleInput {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly prompt: string;
  readonly scheduleKind: ThreadScheduleKind;
  readonly intervalSeconds: number | null;
  readonly cronExpression?: string | null;
  readonly timezone?: string | null;
  readonly skipDates?: ReadonlyArray<string>;
  readonly nextRunAt: string;
  readonly createdAt: string;
}

const parseSkipDates = (value: string): ReadonlyArray<string> => {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
};

const fromRow = (row: ThreadScheduleRow): ThreadSchedule => {
  const { skipDatesJson, ...schedule } = row;
  return {
    ...schedule,
    threadId: ThreadId.make(row.threadId),
    skipDates: parseSkipDates(skipDatesJson),
  };
};

const fromProjectRow = (row: ProjectThreadScheduleRow): ProjectThreadSchedule => ({
  ...fromRow(row),
  projectId: ProjectId.make(row.projectId),
  threadTitle: row.threadTitle,
});

const sqlError = (operation: string) => (cause: unknown) =>
  new PersistenceSqlError({ operation, cause });

export class ThreadScheduleRepository extends Context.Service<
  ThreadScheduleRepository,
  {
    readonly create: (
      input: CreateThreadScheduleInput,
    ) => Effect.Effect<ThreadSchedule, PersistenceSqlError>;
    readonly list: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ThreadSchedule>, PersistenceSqlError>;
    readonly listProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<ProjectThreadSchedule>, PersistenceSqlError>;
    readonly listDue: (
      now: string,
    ) => Effect.Effect<ReadonlyArray<ThreadSchedule>, PersistenceSqlError>;
    readonly setPaused: (
      id: string,
      threadId: ThreadId,
      paused: boolean,
      now: string,
    ) => Effect.Effect<boolean, PersistenceSqlError>;
    readonly setPausedForProject: (
      id: string,
      projectId: ProjectId,
      paused: boolean,
      now: string,
    ) => Effect.Effect<boolean, PersistenceSqlError>;
    readonly remove: (
      id: string,
      threadId: ThreadId,
    ) => Effect.Effect<boolean, PersistenceSqlError>;
    readonly removeForProject: (
      id: string,
      projectId: ProjectId,
    ) => Effect.Effect<boolean, PersistenceSqlError>;
    readonly defer: (
      id: string,
      expectedRunAt: string,
      nextRunAt: string,
      updatedAt: string,
    ) => Effect.Effect<boolean, PersistenceSqlError>;
    readonly recordRun: (
      schedule: ThreadSchedule,
      runAt: string,
      nextRunAt: string | null,
    ) => Effect.Effect<boolean, PersistenceSqlError>;
  }
>()("t3/persistence/ThreadSchedules/ThreadScheduleRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return ThreadScheduleRepository.of({
    create: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO thread_schedules (
                id, thread_id, prompt, schedule_kind, interval_seconds,
                cron_expression, timezone, skip_dates_json,
                next_run_at, status, last_run_at, created_at, updated_at
              ) VALUES (
                ${input.id}, ${input.threadId}, ${input.prompt}, ${input.scheduleKind},
                ${input.intervalSeconds}, ${input.cronExpression ?? null}, ${input.timezone ?? null},
                ${JSON.stringify(input.skipDates ?? [])}, ${input.nextRunAt}, 'active', NULL,
                ${input.createdAt}, ${input.createdAt}
              )
            `;
            const rows = yield* sql<ThreadScheduleRow>`
              SELECT id,
                thread_id AS "threadId",
                prompt,
                schedule_kind AS "scheduleKind",
                interval_seconds AS "intervalSeconds",
                cron_expression AS "cronExpression",
                timezone,
                skip_dates_json AS "skipDatesJson",
                next_run_at AS "nextRunAt",
                status,
                last_run_at AS "lastRunAt",
                created_at AS "createdAt",
                updated_at AS "updatedAt" FROM thread_schedules WHERE id = ${input.id}
            `;
            return fromRow(rows[0]!);
          }),
        )
        .pipe(Effect.mapError(sqlError("createThreadSchedule"))),

    list: (threadId) =>
      sql<ThreadScheduleRow>`
        SELECT id,
                thread_id AS "threadId",
                prompt,
                schedule_kind AS "scheduleKind",
                interval_seconds AS "intervalSeconds",
                cron_expression AS "cronExpression",
                timezone,
                skip_dates_json AS "skipDatesJson",
                next_run_at AS "nextRunAt",
                status,
                last_run_at AS "lastRunAt",
                created_at AS "createdAt",
                updated_at AS "updatedAt"
        FROM thread_schedules
        WHERE thread_id = ${threadId}
        ORDER BY created_at DESC
        LIMIT 100
      `.pipe(
        Effect.map((rows) => rows.map(fromRow)),
        Effect.mapError(sqlError("listThreadSchedules")),
      ),

    listProject: (projectId) =>
      sql<ProjectThreadScheduleRow>`
        SELECT s.id,
               s.thread_id AS "threadId",
               t.project_id AS "projectId",
               t.title AS "threadTitle",
               s.prompt,
               s.schedule_kind AS "scheduleKind",
               s.interval_seconds AS "intervalSeconds",
               s.cron_expression AS "cronExpression",
               s.timezone,
               s.skip_dates_json AS "skipDatesJson",
               s.next_run_at AS "nextRunAt",
               s.status,
               s.last_run_at AS "lastRunAt",
               s.created_at AS "createdAt",
               s.updated_at AS "updatedAt"
        FROM thread_schedules s
        INNER JOIN projection_threads t ON t.thread_id = s.thread_id
        WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL
        ORDER BY s.created_at DESC
        LIMIT 500
      `.pipe(
        Effect.map((rows) => rows.map(fromProjectRow)),
        Effect.mapError(sqlError("listProjectThreadSchedules")),
      ),

    listDue: (now) =>
      sql<ThreadScheduleRow>`
        SELECT id,
                thread_id AS "threadId",
                prompt,
                schedule_kind AS "scheduleKind",
                interval_seconds AS "intervalSeconds",
                cron_expression AS "cronExpression",
                timezone,
                skip_dates_json AS "skipDatesJson",
                next_run_at AS "nextRunAt",
                status,
                last_run_at AS "lastRunAt",
                created_at AS "createdAt",
                updated_at AS "updatedAt"
        FROM thread_schedules
        WHERE status = 'active' AND next_run_at <= ${now}
        ORDER BY next_run_at ASC
        LIMIT 50
      `.pipe(
        Effect.map((rows) => rows.map(fromRow)),
        Effect.mapError(sqlError("listDueThreadSchedules")),
      ),

    setPaused: (id, threadId, paused, now) =>
      (paused
        ? sql`
            UPDATE thread_schedules
            SET status = 'paused', updated_at = ${now}
            WHERE id = ${id} AND thread_id = ${threadId} AND status = 'active'
            RETURNING id
          `
        : sql`
            UPDATE thread_schedules
            SET status = 'active',
                next_run_at = CASE WHEN next_run_at < ${now} THEN ${now} ELSE next_run_at END,
                updated_at = ${now}
            WHERE id = ${id} AND thread_id = ${threadId} AND status = 'paused'
            RETURNING id
          `
      ).pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(sqlError("setThreadSchedulePaused")),
      ),

    setPausedForProject: (id, projectId, paused, now) =>
      (paused
        ? sql`
            UPDATE thread_schedules
            SET status = 'paused', updated_at = ${now}
            WHERE id = ${id}
              AND status = 'active'
              AND thread_id IN (
                SELECT thread_id FROM projection_threads
                WHERE project_id = ${projectId} AND deleted_at IS NULL
              )
            RETURNING id
          `
        : sql`
            UPDATE thread_schedules
            SET status = 'active',
                next_run_at = CASE WHEN next_run_at < ${now} THEN ${now} ELSE next_run_at END,
                updated_at = ${now}
            WHERE id = ${id}
              AND status = 'paused'
              AND thread_id IN (
                SELECT thread_id FROM projection_threads
                WHERE project_id = ${projectId} AND deleted_at IS NULL
              )
            RETURNING id
          `
      ).pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(sqlError("setProjectThreadSchedulePaused")),
      ),

    remove: (id, threadId) =>
      sql`DELETE FROM thread_schedules WHERE id = ${id} AND thread_id = ${threadId} RETURNING id`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(sqlError("removeThreadSchedule")),
      ),

    removeForProject: (id, projectId) =>
      sql`
        DELETE FROM thread_schedules
        WHERE id = ${id}
          AND thread_id IN (
            SELECT thread_id FROM projection_threads
            WHERE project_id = ${projectId} AND deleted_at IS NULL
          )
        RETURNING id
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(sqlError("removeProjectThreadSchedule")),
      ),

    defer: (id, expectedRunAt, nextRunAt, updatedAt) =>
      sql`
        UPDATE thread_schedules
        SET next_run_at = ${nextRunAt}, updated_at = ${updatedAt}
        WHERE id = ${id} AND status = 'active' AND next_run_at = ${expectedRunAt}
        RETURNING id
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(sqlError("deferThreadSchedule")),
      ),

    recordRun: (schedule, runAt, nextRunAt) =>
      (nextRunAt === null
        ? sql`
            UPDATE thread_schedules
            SET status = 'completed', last_run_at = ${runAt}, updated_at = ${runAt}
            WHERE id = ${schedule.id}
              AND status = 'active'
              AND next_run_at = ${schedule.nextRunAt}
            RETURNING id
          `
        : sql`
            UPDATE thread_schedules
            SET next_run_at = ${nextRunAt}, last_run_at = ${runAt}, updated_at = ${runAt}
            WHERE id = ${schedule.id}
              AND status = 'active'
              AND next_run_at = ${schedule.nextRunAt}
            RETURNING id
          `
      ).pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(sqlError("recordThreadScheduleRun")),
      ),
  });
});

export const layer = Layer.effect(ThreadScheduleRepository, make);
