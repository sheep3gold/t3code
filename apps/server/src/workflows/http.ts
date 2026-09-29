import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as Workflows from "../persistence/ThreadWorkflows.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const MAX_STEPS = 20;
const MAX_NAME_CHARS = 120;
const MAX_STEP_TITLE_CHARS = 120;
const MAX_STEP_PROMPT_CHARS = 10_000;
const MAX_ATTEMPTS = 3;

const clip = (value: string, limit: number) => Array.from(value.trim()).slice(0, limit).join("");

export const workflowsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "workflows",
  Effect.fnUntraced(function* (handlers) {
    const repository = yield* Workflows.ThreadWorkflowRepository;
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const crypto = yield* Crypto.Crypto;
    const readScope = (endpoint: string) =>
      annotateEnvironmentRequest(endpoint).pipe(
        Effect.andThen(requireEnvironmentScope(AuthOrchestrationReadScope)),
      );
    const operateScope = (endpoint: string) =>
      annotateEnvironmentRequest(endpoint).pipe(
        Effect.andThen(requireEnvironmentScope(AuthOrchestrationOperateScope)),
      );
    const internal = (cause: unknown) => failEnvironmentInternal("internal_error", cause);
    const required = (
      workflowId: string,
      projectId: Parameters<typeof repository.getForProject>[1],
    ) =>
      repository.getForProject(workflowId, projectId).pipe(
        Effect.catch(internal),
        Effect.flatMap(
          Option.match({
            onNone: () => failEnvironmentNotFound("workflow_not_found"),
            onSome: Effect.succeed,
          }),
        ),
      );

    return handlers
      .handle(
        "list",
        Effect.fn("environment.workflows.list")(function* (args) {
          yield* readScope(args.endpoint.name);
          return {
            workflows: yield* repository
              .listProject(args.payload.projectId)
              .pipe(Effect.catch(internal)),
          };
        }),
      )
      .handle(
        "get",
        Effect.fn("environment.workflows.get")(function* (args) {
          yield* readScope(args.endpoint.name);
          return yield* required(args.params.workflowId, args.payload.projectId);
        }),
      )
      .handle(
        "create",
        Effect.fn("environment.workflows.create")(function* (args) {
          yield* operateScope(args.endpoint.name);
          const thread = yield* snapshots
            .getThreadShellById(args.payload.threadId)
            .pipe(Effect.catch(internal));
          if (Option.isNone(thread) || thread.value.projectId !== args.payload.projectId) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          if (args.payload.steps.length < 1 || args.payload.steps.length > MAX_STEPS) {
            return yield* failEnvironmentInvalidRequest("invalid_workflow");
          }
          const name = clip(args.payload.name, MAX_NAME_CHARS);
          const steps = args.payload.steps.map((step, index) => ({
            title: clip(step.title, MAX_STEP_TITLE_CHARS),
            prompt: clip(step.prompt, MAX_STEP_PROMPT_CHARS),
            dependsOn: [...new Set(step.dependsOn ?? (index === 0 ? [] : [index - 1]))],
          }));
          if (
            !name ||
            steps.some(
              (step, index) =>
                !step.title ||
                !step.prompt ||
                step.dependsOn.some((dependency) => dependency < 0 || dependency >= index),
            )
          ) {
            return yield* failEnvironmentInvalidRequest("invalid_workflow");
          }
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          const workflow = yield* repository
            .create({
              id: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
              threadId: args.payload.threadId,
              name,
              steps,
              createdAt,
            })
            .pipe(Effect.catch(internal));
          return { ...workflow, threadTitle: thread.value.title };
        }),
      )
      .handle(
        "pause",
        Effect.fn("environment.workflows.pause")(function* (args) {
          yield* operateScope(args.endpoint.name);
          const workflow = yield* required(args.params.workflowId, args.payload.projectId);
          const changed = yield* repository
            .setPaused(
              workflow.id,
              workflow.threadId,
              true,
              DateTime.formatIso(yield* DateTime.now),
            )
            .pipe(Effect.catch(internal));
          return { changed };
        }),
      )
      .handle(
        "resume",
        Effect.fn("environment.workflows.resume")(function* (args) {
          yield* operateScope(args.endpoint.name);
          const workflow = yield* required(args.params.workflowId, args.payload.projectId);
          const changed = yield* repository
            .setPaused(
              workflow.id,
              workflow.threadId,
              false,
              DateTime.formatIso(yield* DateTime.now),
            )
            .pipe(Effect.catch(internal));
          return { changed };
        }),
      )
      .handle(
        "retry",
        Effect.fn("environment.workflows.retry")(function* (args) {
          yield* operateScope(args.endpoint.name);
          const workflow = yield* required(args.params.workflowId, args.payload.projectId);
          const retried = yield* repository
            .retryCurrent(
              workflow.id,
              workflow.threadId,
              DateTime.formatIso(yield* DateTime.now),
              MAX_ATTEMPTS,
            )
            .pipe(Effect.catch(internal));
          if (Option.isNone(retried)) {
            return yield* failEnvironmentInvalidRequest("workflow_not_retryable");
          }
          return { ...retried.value, threadTitle: workflow.threadTitle };
        }),
      )
      .handle(
        "restart",
        Effect.fn("environment.workflows.restart")(function* (args) {
          yield* operateScope(args.endpoint.name);
          const workflow = yield* required(args.params.workflowId, args.payload.projectId);
          const fromIndex = args.payload.fromStep - 1;
          if (
            fromIndex < 0 ||
            fromIndex >= workflow.steps.length ||
            workflow.steps.slice(0, fromIndex).some((step) => step.status !== "completed")
          ) {
            return yield* failEnvironmentInvalidRequest("workflow_not_restartable");
          }
          const restarted = yield* repository
            .restartFrom(
              workflow.id,
              workflow.threadId,
              fromIndex,
              DateTime.formatIso(yield* DateTime.now),
            )
            .pipe(Effect.catch(internal));
          if (Option.isNone(restarted)) {
            return yield* failEnvironmentInvalidRequest("workflow_not_restartable");
          }
          return { ...restarted.value, threadTitle: workflow.threadTitle };
        }),
      )
      .handle(
        "cancel",
        Effect.fn("environment.workflows.cancel")(function* (args) {
          yield* operateScope(args.endpoint.name);
          const workflow = yield* required(args.params.workflowId, args.payload.projectId);
          const changed = yield* repository
            .cancel(workflow.id, workflow.threadId, DateTime.formatIso(yield* DateTime.now))
            .pipe(Effect.catch(internal));
          return { changed };
        }),
      );
  }),
);
