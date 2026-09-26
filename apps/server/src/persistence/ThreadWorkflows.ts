import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError } from "./Errors.ts";

export type WorkflowStatus = "running" | "paused" | "completed" | "failed" | "cancelled";
export type WorkflowStepStatus = "pending" | "running" | "completed" | "failed";

export interface WorkflowStep {
  readonly index: number;
  readonly title: string;
  readonly prompt: string;
  readonly status: WorkflowStepStatus;
  readonly attempt: number;
  readonly result: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface ThreadWorkflow {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly name: string;
  readonly status: WorkflowStatus;
  readonly currentStep: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly steps: ReadonlyArray<WorkflowStep>;
}

interface WorkflowRow {
  readonly id: string;
  readonly threadId: string;
  readonly name: string;
  readonly status: WorkflowStatus;
  readonly currentStep: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
interface StepRow extends WorkflowStep {
  readonly workflowId: string;
}

const sqlError = (operation: string) => (cause: unknown) =>
  new PersistenceSqlError({ operation, cause });

export class ThreadWorkflowRepository extends Context.Service<
  ThreadWorkflowRepository,
  {
    readonly create: (input: {
      readonly id: string;
      readonly threadId: ThreadId;
      readonly name: string;
      readonly steps: ReadonlyArray<{ readonly title: string; readonly prompt: string }>;
      readonly createdAt: string;
    }) => Effect.Effect<ThreadWorkflow, PersistenceSqlError>;
    readonly get: (
      id: string,
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<ThreadWorkflow>, PersistenceSqlError>;
    readonly list: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ThreadWorkflow>, PersistenceSqlError>;
    readonly listRunnable: () => Effect.Effect<ReadonlyArray<ThreadWorkflow>, PersistenceSqlError>;
    readonly markRunning: (
      workflow: ThreadWorkflow,
      now: string,
    ) => Effect.Effect<boolean, PersistenceSqlError>;
    readonly completeCurrent: (
      id: string,
      threadId: ThreadId,
      result: string,
      now: string,
    ) => Effect.Effect<Option.Option<ThreadWorkflow>, PersistenceSqlError>;
    readonly failCurrent: (
      id: string,
      threadId: ThreadId,
      result: string,
      now: string,
    ) => Effect.Effect<Option.Option<ThreadWorkflow>, PersistenceSqlError>;
    readonly setPaused: (
      id: string,
      threadId: ThreadId,
      paused: boolean,
      now: string,
    ) => Effect.Effect<boolean, PersistenceSqlError>;
    readonly cancel: (
      id: string,
      threadId: ThreadId,
      now: string,
    ) => Effect.Effect<boolean, PersistenceSqlError>;
    readonly retryCurrent: (
      id: string,
      threadId: ThreadId,
      now: string,
      maxAttempts: number,
    ) => Effect.Effect<Option.Option<ThreadWorkflow>, PersistenceSqlError>;
    readonly restartFrom: (
      id: string,
      threadId: ThreadId,
      fromStep: number,
      now: string,
    ) => Effect.Effect<Option.Option<ThreadWorkflow>, PersistenceSqlError>;
  }
>()("t3/persistence/ThreadWorkflowRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const get = (id: string, threadId: ThreadId) =>
    Effect.gen(function* () {
      const workflows = yield* sql<WorkflowRow>`
        SELECT id, thread_id AS "threadId", name, status,
               current_step AS "currentStep", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM thread_workflows WHERE id = ${id} AND thread_id = ${threadId} LIMIT 1
      `;
      const workflow = workflows[0];
      if (!workflow) return Option.none<ThreadWorkflow>();
      const steps = yield* sql<StepRow>`
        SELECT workflow_id AS "workflowId", step_index AS "index", title, prompt, status,
               attempt, result, started_at AS "startedAt", completed_at AS "completedAt"
        FROM thread_workflow_steps WHERE workflow_id = ${id} ORDER BY step_index
      `;
      return Option.some({
        ...workflow,
        threadId: ThreadId.make(workflow.threadId),
        steps: steps.map(({ workflowId: _workflowId, ...step }) => step),
      });
    }).pipe(Effect.mapError(sqlError("getThreadWorkflow")));

  const updateCurrent = (
    id: string,
    threadId: ThreadId,
    status: "completed" | "failed",
    result: string,
    now: string,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly currentStep: number }>`
            SELECT current_step AS "currentStep" FROM thread_workflows
            WHERE id = ${id} AND thread_id = ${threadId} AND status = 'running' LIMIT 1
          `;
          const current = rows[0];
          if (!current) return false;
          const changed = yield* sql`
            UPDATE thread_workflow_steps
            SET status = ${status}, result = ${result}, completed_at = ${now}
            WHERE workflow_id = ${id} AND step_index = ${current.currentStep} AND status = 'running'
            RETURNING step_index
          `;
          if (changed.length === 0) return false;
          if (status === "failed") {
            yield* sql`UPDATE thread_workflows SET status = 'failed', updated_at = ${now} WHERE id = ${id}`;
            return true;
          }
          const remaining = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM thread_workflow_steps
            WHERE workflow_id = ${id} AND step_index > ${current.currentStep}
          `;
          if ((remaining[0]?.count ?? 0) === 0) {
            yield* sql`UPDATE thread_workflows SET status = 'completed', updated_at = ${now} WHERE id = ${id}`;
          } else {
            yield* sql`
              UPDATE thread_workflows
              SET current_step = ${current.currentStep + 1}, updated_at = ${now}
              WHERE id = ${id}
            `;
          }
          return true;
        }),
      )
      .pipe(
        Effect.flatMap((changed) => changed ? get(id, threadId) : Effect.succeed(Option.none())),
        Effect.mapError(sqlError(`updateThreadWorkflowCurrent:${status}`)),
      );

  return ThreadWorkflowRepository.of({
    create: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO thread_workflows (
                id, thread_id, name, status, current_step, created_at, updated_at
              ) VALUES (${input.id}, ${input.threadId}, ${input.name}, 'running', 0, ${input.createdAt}, ${input.createdAt})
            `;
            yield* Effect.forEach(
              input.steps,
              (step, index) => sql`
                INSERT INTO thread_workflow_steps (
                  workflow_id, step_index, title, prompt, status, attempt
                ) VALUES (${input.id}, ${index}, ${step.title}, ${step.prompt}, 'pending', 1)
              `,
              { discard: true },
            );
          }),
        )
        .pipe(
          Effect.andThen(get(input.id, input.threadId)),
          Effect.map(Option.getOrThrow),
          Effect.mapError(sqlError("createThreadWorkflow")),
        ),
    get,
    list: (threadId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly id: string }>`
          SELECT id FROM thread_workflows WHERE thread_id = ${threadId}
          ORDER BY created_at DESC LIMIT 50
        `;
        return yield* Effect.forEach(rows, (row) => get(row.id, threadId)).pipe(
          Effect.map((items) => items.flatMap(Option.toArray)),
        );
      }).pipe(Effect.mapError(sqlError("listThreadWorkflows"))),
    listRunnable: () =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly id: string; readonly threadId: string }>`
          SELECT id, thread_id AS "threadId" FROM thread_workflows
          WHERE status = 'running' ORDER BY updated_at ASC LIMIT 50
        `;
        return yield* Effect.forEach(rows, (row) => get(row.id, ThreadId.make(row.threadId))).pipe(
          Effect.map((items) => items.flatMap(Option.toArray)),
        );
      }).pipe(Effect.mapError(sqlError("listRunnableThreadWorkflows"))),
    markRunning: (workflow, now) =>
      sql`
        UPDATE thread_workflow_steps
        SET status = 'running', started_at = ${now}
        WHERE workflow_id = ${workflow.id} AND step_index = ${workflow.currentStep} AND status = 'pending'
        RETURNING step_index
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(sqlError("markThreadWorkflowStepRunning")),
      ),
    completeCurrent: (id, threadId, result, now) =>
      updateCurrent(id, threadId, "completed", result, now),
    failCurrent: (id, threadId, result, now) => updateCurrent(id, threadId, "failed", result, now),
    setPaused: (id, threadId, paused, now) =>
      (paused
        ? sql`
            UPDATE thread_workflows SET status = 'paused', updated_at = ${now}
            WHERE id = ${id} AND thread_id = ${threadId} AND status = 'running'
              AND EXISTS (
                SELECT 1 FROM thread_workflow_steps s
                WHERE s.workflow_id = thread_workflows.id
                  AND s.step_index = thread_workflows.current_step
                  AND s.status = 'pending'
              )
            RETURNING id
          `
        : sql`
            UPDATE thread_workflows SET status = 'running', updated_at = ${now}
            WHERE id = ${id} AND thread_id = ${threadId} AND status = 'paused' RETURNING id
          `
      ).pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(sqlError("setThreadWorkflowPaused")),
      ),
    cancel: (id, threadId, now) =>
      sql`
        UPDATE thread_workflows SET status = 'cancelled', updated_at = ${now}
        WHERE id = ${id} AND thread_id = ${threadId}
          AND status IN ('running', 'paused', 'failed') RETURNING id
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(sqlError("cancelThreadWorkflow")),
      ),
    retryCurrent: (id, threadId, now, maxAttempts) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly currentStep: number; readonly attempt: number }>`
              SELECT w.current_step AS "currentStep", s.attempt
              FROM thread_workflows w
              JOIN thread_workflow_steps s
                ON s.workflow_id = w.id AND s.step_index = w.current_step
              WHERE w.id = ${id} AND w.thread_id = ${threadId}
                AND w.status IN ('running', 'failed') AND s.status IN ('running', 'failed')
              LIMIT 1
            `;
            const current = rows[0];
            if (!current || current.attempt >= maxAttempts) return false;
            yield* sql`
              UPDATE thread_workflow_steps
              SET status = 'pending', attempt = ${current.attempt + 1}, result = NULL,
                  started_at = NULL, completed_at = NULL
              WHERE workflow_id = ${id} AND step_index = ${current.currentStep}
            `;
            yield* sql`UPDATE thread_workflows SET status = 'running', updated_at = ${now} WHERE id = ${id}`;
            return true;
          }),
        )
        .pipe(
          Effect.flatMap((changed) => changed ? get(id, threadId) : Effect.succeed(Option.none())),
          Effect.mapError(sqlError("retryThreadWorkflowStep")),
        ),
    restartFrom: (id, threadId, fromStep, now) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const workflows = yield* sql<{ readonly id: string }>`
              SELECT id FROM thread_workflows WHERE id = ${id} AND thread_id = ${threadId} LIMIT 1
            `;
            if (workflows.length === 0) return false;
            const bounds = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM thread_workflow_steps WHERE workflow_id = ${id}
            `;
            if (fromStep < 0 || fromStep >= (bounds[0]?.count ?? 0)) return false;
            const incompletePrefix = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM thread_workflow_steps
              WHERE workflow_id = ${id} AND step_index < ${fromStep} AND status <> 'completed'
            `;
            if ((incompletePrefix[0]?.count ?? 0) > 0) return false;
            yield* sql`
              UPDATE thread_workflow_steps
              SET status = 'pending', attempt = 1, result = NULL,
                  started_at = NULL, completed_at = NULL
              WHERE workflow_id = ${id} AND step_index >= ${fromStep}
            `;
            yield* sql`
              UPDATE thread_workflows
              SET status = 'running', current_step = ${fromStep}, updated_at = ${now}
              WHERE id = ${id}
            `;
            return true;
          }),
        )
        .pipe(
          Effect.flatMap((changed) => changed ? get(id, threadId) : Effect.succeed(Option.none())),
          Effect.mapError(sqlError("restartThreadWorkflowFromStep")),
        ),
  });
});

export const layer = Layer.effect(ThreadWorkflowRepository, make);
