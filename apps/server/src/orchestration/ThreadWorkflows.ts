import {
  CommandId,
  MessageId,
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

import * as WorkflowPersistence from "../persistence/ThreadWorkflows.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

const MAX_STEPS = 20;
const MAX_NAME_CHARS = 120;
const MAX_STEP_TITLE_CHARS = 120;
const MAX_STEP_PROMPT_CHARS = 10_000;
const MAX_RESULT_CHARS = 4_000;
const MAX_ATTEMPTS = 3;
const STALE_RUNNING_MS = 5 * 60_000;

const StepInput = Schema.Struct({
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
});
const StartWorkflowInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  steps: Schema.Array(StepInput),
});
const WorkflowIdInput = Schema.Struct({ workflowId: TrimmedNonEmptyString });
const RestartWorkflowInput = Schema.Struct({
  workflowId: TrimmedNonEmptyString,
  fromStep: Schema.Int,
});
const WorkflowResultInput = Schema.Struct({
  workflowId: TrimmedNonEmptyString,
  result: TrimmedNonEmptyString,
});

const WorkflowStep = Schema.Struct({
  index: Schema.Number,
  title: Schema.String,
  prompt: Schema.String,
  status: Schema.Literals(["pending", "running", "completed", "failed"]),
  attempt: Schema.Number,
  result: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
});
const Workflow = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["running", "paused", "completed", "failed", "cancelled"]),
  currentStep: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  steps: Schema.Array(WorkflowStep),
});

export class WorkflowInputInvalidError extends Schema.TaggedError<WorkflowInputInvalidError>()(
  "WorkflowInputInvalidError",
  { detail: Schema.String },
) {
  override get message(): string { return this.detail; }
}
export class WorkflowNotFoundError extends Schema.TaggedError<WorkflowNotFoundError>()(
  "WorkflowNotFoundError",
  { workflowId: Schema.String },
) {
  override get message(): string { return `Workflow '${this.workflowId}' was not found in this thread.`; }
}
export class WorkflowThreadNotFoundError extends Schema.TaggedError<WorkflowThreadNotFoundError>()(
  "WorkflowThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string { return `Thread ${this.threadId} was not found.`; }
}
export class WorkflowOperationError extends Schema.TaggedError<WorkflowOperationError>()(
  "WorkflowOperationError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string { return `Workflow operation '${this.operation}' failed.`; }
}
const WorkflowToolError = Schema.Union([
  WorkflowInputInvalidError,
  WorkflowNotFoundError,
  WorkflowThreadNotFoundError,
  WorkflowOperationError,
]);

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  WorkflowPersistence.ThreadWorkflowRepository,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  Crypto.Crypto,
  Clock.Clock,
];

const StartWorkflowTool = Tool.make("workflow_start", {
  description:
    "Start a persistent sequential workflow in this thread. Each step runs as a separate agent turn and must call workflow_complete_step or workflow_fail_step before finishing. The workflow survives server/provider restarts.",
  parameters: StartWorkflowInput,
  success: Workflow,
  failure: WorkflowToolError,
  dependencies,
}).annotate(Tool.Title, "Start workflow").annotate(Tool.Readonly, false).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, false).annotate(Tool.OpenWorld, false);

const ListWorkflowsTool = Tool.make("workflow_list", {
  description: "List persistent workflows owned by this thread.",
  success: Schema.Struct({ workflows: Schema.Array(Workflow) }),
  failure: WorkflowToolError,
  dependencies,
}).annotate(Tool.Title, "List workflows").annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true).annotate(Tool.OpenWorld, false);

const GetWorkflowTool = Tool.make("workflow_get", {
  description: "Read one workflow with all step attempts and results.",
  parameters: WorkflowIdInput,
  success: Workflow,
  failure: WorkflowToolError,
  dependencies,
}).annotate(Tool.Title, "Get workflow").annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true).annotate(Tool.OpenWorld, false);

const CompleteWorkflowStepTool = Tool.make("workflow_complete_step", {
  description: "Mark the current running workflow step complete. The runner starts the next step after this turn settles.",
  parameters: WorkflowResultInput,
  success: Workflow,
  failure: WorkflowToolError,
  dependencies,
}).annotate(Tool.Title, "Complete workflow step").annotate(Tool.Readonly, false).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, false).annotate(Tool.OpenWorld, false);

const FailWorkflowStepTool = Tool.make("workflow_fail_step", {
  description: "Mark the current workflow step failed with a concrete reason. The workflow stops until retried or cancelled.",
  parameters: WorkflowResultInput,
  success: Workflow,
  failure: WorkflowToolError,
  dependencies,
}).annotate(Tool.Title, "Fail workflow step").annotate(Tool.Readonly, false).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, false).annotate(Tool.OpenWorld, false);

const PauseWorkflowTool = Tool.make("workflow_pause", {
  description: "Pause a workflow while its next step is pending. A running step must finish or fail first.",
  parameters: WorkflowIdInput,
  success: Schema.Struct({ changed: Schema.Boolean }),
  failure: WorkflowToolError,
  dependencies,
}).annotate(Tool.Title, "Pause workflow").annotate(Tool.Readonly, false).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true).annotate(Tool.OpenWorld, false);

const ResumeWorkflowTool = Tool.make("workflow_resume", {
  description: "Resume a paused workflow.",
  parameters: WorkflowIdInput,
  success: Schema.Struct({ changed: Schema.Boolean }),
  failure: WorkflowToolError,
  dependencies,
}).annotate(Tool.Title, "Resume workflow").annotate(Tool.Readonly, false).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true).annotate(Tool.OpenWorld, false);

const RetryWorkflowTool = Tool.make("workflow_retry_step", {
  description: "Retry the current failed or orphaned workflow step, up to three attempts.",
  parameters: WorkflowIdInput,
  success: Workflow,
  failure: WorkflowToolError,
  dependencies,
}).annotate(Tool.Title, "Retry workflow step").annotate(Tool.Readonly, false).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, false).annotate(Tool.OpenWorld, false);

const RestartWorkflowTool = Tool.make("workflow_restart_from", {
  description:
    "Restart a workflow from a 1-based step number. Completed prefix steps and their results are reused unchanged; the selected step and every later step are reset and re-executed.",
  parameters: RestartWorkflowInput,
  success: Workflow,
  failure: WorkflowToolError,
  dependencies,
}).annotate(Tool.Title, "Restart workflow from step").annotate(Tool.Readonly, false).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, false).annotate(Tool.OpenWorld, false);

const CancelWorkflowTool = Tool.make("workflow_cancel", {
  description: "Cancel a running, paused, or failed workflow. Completed step history remains readable.",
  parameters: WorkflowIdInput,
  success: Schema.Struct({ changed: Schema.Boolean }),
  failure: WorkflowToolError,
  dependencies,
}).annotate(Tool.Title, "Cancel workflow").annotate(Tool.Readonly, false).annotate(Tool.Destructive, true).annotate(Tool.Idempotent, true).annotate(Tool.OpenWorld, false);

export const ThreadWorkflowToolkit = Toolkit.make(
  StartWorkflowTool,
  ListWorkflowsTool,
  GetWorkflowTool,
  CompleteWorkflowStepTool,
  FailWorkflowStepTool,
  PauseWorkflowTool,
  ResumeWorkflowTool,
  RetryWorkflowTool,
  RestartWorkflowTool,
  CancelWorkflowTool,
);

function clip(value: string, limit: number): string {
  return Array.from(value.trim()).slice(0, limit).join("");
}

const makeToolkit = Effect.gen(function* () {
  const repository = yield* WorkflowPersistence.ThreadWorkflowRepository;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const context = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const thread = yield* snapshots.getThreadShellById(scope.threadId).pipe(
      Effect.mapError((cause) => new WorkflowOperationError({ operation: "read-thread", cause })),
      Effect.map(Option.getOrUndefined),
    );
    if (!thread || thread.archivedAt !== null || thread.deletedAt !== null) {
      return yield* new WorkflowThreadNotFoundError({ threadId: scope.threadId });
    }
    return scope;
  });
  const opError = (operation: string) =>
    Effect.mapError((cause: unknown) => new WorkflowOperationError({ operation, cause }));
  const required = (workflowId: string, value: Option.Option<WorkflowPersistence.ThreadWorkflow>) =>
    Option.match(value, {
      onNone: () => Effect.fail(new WorkflowNotFoundError({ workflowId })),
      onSome: Effect.succeed,
    });
  const mutate = Effect.fn("ThreadWorkflow.mutate")(function* (
    operation: "pause" | "resume" | "cancel",
    workflowId: string,
  ) {
    const scope = yield* context;
    const now = new Date(yield* Clock.currentTimeMillis).toISOString();
    const changed = yield* (operation === "cancel"
      ? repository.cancel(workflowId, scope.threadId, now)
      : repository.setPaused(workflowId, scope.threadId, operation === "pause", now)
    ).pipe(opError(operation));
    return { changed };
  });

  return ThreadWorkflowToolkit.of({
    workflow_start: (input) =>
      Effect.gen(function* () {
        const scope = yield* context;
        if (input.steps.length < 1 || input.steps.length > MAX_STEPS) {
          return yield* new WorkflowInputInvalidError({ detail: `steps must contain 1-${MAX_STEPS} entries.` });
        }
        const name = clip(input.name, MAX_NAME_CHARS);
        const steps = input.steps.map((step) => ({
          title: clip(step.title, MAX_STEP_TITLE_CHARS),
          prompt: clip(step.prompt, MAX_STEP_PROMPT_CHARS),
        }));
        if (!name || steps.some((step) => !step.title || !step.prompt)) {
          return yield* new WorkflowInputInvalidError({ detail: "workflow name, step titles, and prompts must be non-empty." });
        }
        const createdAt = new Date(yield* Clock.currentTimeMillis).toISOString();
        return yield* repository.create({
          id: yield* crypto.randomUUIDv4,
          threadId: scope.threadId,
          name,
          steps,
          createdAt,
        }).pipe(opError("start"));
      }),
    workflow_list: () => Effect.gen(function* () {
      const scope = yield* context;
      return { workflows: yield* repository.list(scope.threadId).pipe(opError("list")) };
    }),
    workflow_get: ({ workflowId }) => Effect.gen(function* () {
      const scope = yield* context;
      return yield* repository.get(workflowId, scope.threadId).pipe(opError("get"), Effect.flatMap((value) => required(workflowId, value)));
    }),
    workflow_complete_step: ({ workflowId, result }) => Effect.gen(function* () {
      const scope = yield* context;
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      const value = yield* repository.completeCurrent(workflowId, scope.threadId, clip(result, MAX_RESULT_CHARS), now).pipe(opError("complete-step"));
      return yield* required(workflowId, value);
    }),
    workflow_fail_step: ({ workflowId, result }) => Effect.gen(function* () {
      const scope = yield* context;
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      const value = yield* repository.failCurrent(workflowId, scope.threadId, clip(result, MAX_RESULT_CHARS), now).pipe(opError("fail-step"));
      return yield* required(workflowId, value);
    }),
    workflow_pause: ({ workflowId }) => mutate("pause", workflowId),
    workflow_resume: ({ workflowId }) => mutate("resume", workflowId),
    workflow_cancel: ({ workflowId }) => mutate("cancel", workflowId),
    workflow_retry_step: ({ workflowId }) => Effect.gen(function* () {
      const scope = yield* context;
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      const value = yield* repository.retryCurrent(workflowId, scope.threadId, now, MAX_ATTEMPTS).pipe(opError("retry-step"));
      return yield* required(workflowId, value);
    }),
    workflow_restart_from: ({ workflowId, fromStep }) => Effect.gen(function* () {
      const scope = yield* context;
      if (fromStep < 1) {
        return yield* new WorkflowInputInvalidError({ detail: "fromStep must be at least 1." });
      }
      const current = yield* repository.get(workflowId, scope.threadId).pipe(
        opError("get"),
        Effect.flatMap((value) => required(workflowId, value)),
      );
      if (fromStep > current.steps.length) {
        return yield* new WorkflowInputInvalidError({
          detail: `fromStep must be between 1 and ${current.steps.length}.`,
        });
      }
      if (current.steps.slice(0, fromStep - 1).some((step) => step.status !== "completed")) {
        return yield* new WorkflowInputInvalidError({
          detail: "Every step before fromStep must already be completed.",
        });
      }
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      const restarted = yield* repository
        .restartFrom(workflowId, scope.threadId, fromStep - 1, now)
        .pipe(opError("restart-from"));
      return yield* required(workflowId, restarted);
    }),
  });
});

export const ThreadWorkflowToolkitHandlersLive = ThreadWorkflowToolkit.toLayer(makeToolkit);

const runner = Effect.gen(function* () {
  const repository = yield* WorkflowPersistence.ThreadWorkflowRepository;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;

  const sweep = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const now = new Date(nowMs).toISOString();
    const workflows = yield* repository.listRunnable();
    for (const workflow of workflows) {
      const step = workflow.steps[workflow.currentStep];
      if (!step) continue;
      const thread = yield* snapshots.getThreadShellById(workflow.threadId).pipe(
        Effect.map(Option.getOrUndefined),
      );
      if (!thread || thread.archivedAt !== null || thread.deletedAt !== null) {
        yield* repository.cancel(workflow.id, workflow.threadId, now);
        continue;
      }
      const threadBusy =
        thread.session?.activeTurnId != null ||
        thread.session?.status === "starting" ||
        thread.session?.status === "running" ||
        thread.hasPendingApprovals ||
        thread.hasPendingUserInput;
      if (step.status === "running") {
        const startedMs = Date.parse(step.startedAt ?? now);
        if (!threadBusy && nowMs - startedMs >= STALE_RUNNING_MS) {
          const retried = yield* repository.retryCurrent(
            workflow.id,
            workflow.threadId,
            now,
            MAX_ATTEMPTS,
          );
          if (Option.isNone(retried)) {
            yield* repository.failCurrent(
              workflow.id,
              workflow.threadId,
              `Step did not report completion after ${MAX_ATTEMPTS} attempts.`,
              now,
            );
          }
        }
        continue;
      }
      if (step.status !== "pending" || threadBusy) continue;
      const dispatchKey = `${workflow.id}:${step.index}:${step.attempt}`;
      const result = yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`workflow:${dispatchKey}`),
        threadId: workflow.threadId,
        message: {
          messageId: MessageId.make(`workflow:${dispatchKey}`),
          role: "user",
          text: [
            `[Workflow ${workflow.name} — step ${step.index + 1}/${workflow.steps.length}, attempt ${step.attempt}/${MAX_ATTEMPTS}]`,
            `Step: ${step.title}`,
            step.prompt,
            `Before ending this turn, call workflow_complete_step with workflowId=${workflow.id} and a concise result. If the step cannot be completed, call workflow_fail_step with the concrete blocker. Inspect existing files and ledger first so a retried step does not repeat completed work.`,
          ].join("\n\n"),
          attachments: [],
        },
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: now,
      }).pipe(Effect.either);
      if (result._tag === "Left") {
        yield* Effect.logWarning("workflow step dispatch failed", {
          workflowId: workflow.id,
          stepIndex: step.index,
          cause: result.left,
        });
        continue;
      }
      yield* repository.markRunning(workflow, now);
      yield* Effect.logInfo("workflow step dispatched", {
        workflowId: workflow.id,
        stepIndex: step.index,
        attempt: step.attempt,
      });
    }
  });

  yield* forkParked(
    sweep.pipe(
      Effect.catchCause((cause) => Effect.logWarning("workflow sweep failed", { cause })),
      Effect.repeat(Schedule.spaced("15 seconds")),
    ),
  );
});

export const startThreadWorkflowRunner = runner;
