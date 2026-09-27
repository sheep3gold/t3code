import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { type Atom } from "effect/unstable/reactivity";
import { HttpClient } from "effect/unstable/http";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand, createEnvironmentQueryAtomFamily } from "./runtime.ts";

const DEFAULT_WORKFLOW_TIMEOUT_MS = 10_000;

type WorkflowRequestContext = {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
};

export type WorkflowCreateInput = {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly name: string;
  readonly steps: ReadonlyArray<{ readonly title: string; readonly prompt: string }>;
};

type WorkflowMutationInput = {
  readonly projectId: ProjectId;
  readonly workflowId: string;
};

export const fetchEnvironmentWorkflows = Effect.fn("fetchEnvironmentWorkflows")(function* (
  input: WorkflowRequestContext & { readonly projectId: ProjectId },
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "workflows",
    method: "GET",
    url: (base) => environmentEndpointUrl(base, "/api/workflows"),
    timeoutMs: input.timeoutMs ?? DEFAULT_WORKFLOW_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.list({ payload: { projectId: input.projectId }, headers }),
  });
});

export const fetchEnvironmentWorkflow = Effect.fn("fetchEnvironmentWorkflow")(function* (
  input: WorkflowRequestContext & WorkflowMutationInput,
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "workflows",
    method: "GET",
    url: (base) =>
      environmentEndpointUrl(base, `/api/workflows/${encodeURIComponent(input.workflowId)}`),
    timeoutMs: input.timeoutMs ?? DEFAULT_WORKFLOW_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.get({
        params: { workflowId: input.workflowId },
        payload: { projectId: input.projectId },
        headers,
      }),
  });
});

export const createEnvironmentWorkflow = Effect.fn("createEnvironmentWorkflow")(function* (
  input: WorkflowRequestContext & WorkflowCreateInput,
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "workflows",
    method: "POST",
    url: (base) => environmentEndpointUrl(base, "/api/workflows"),
    timeoutMs: input.timeoutMs ?? DEFAULT_WORKFLOW_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.create({
        payload: {
          projectId: input.projectId,
          threadId: input.threadId,
          name: input.name,
          steps: [...input.steps],
        },
        headers,
      }),
  });
});

type WorkflowStateOperation = "pause" | "resume" | "cancel";

const changeEnvironmentWorkflowState = Effect.fn("changeEnvironmentWorkflowState")(function* (
  input: WorkflowRequestContext &
    WorkflowMutationInput & { readonly operation: WorkflowStateOperation },
) {
  const path = `/api/workflows/${encodeURIComponent(input.workflowId)}/${input.operation}`;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "workflows",
    method: "POST",
    url: (base) => environmentEndpointUrl(base, path),
    timeoutMs: input.timeoutMs ?? DEFAULT_WORKFLOW_TIMEOUT_MS,
    request: ({ client, headers }) =>
      input.operation === "pause"
        ? client.pause({
            params: { workflowId: input.workflowId },
            payload: { projectId: input.projectId },
            headers,
          })
        : input.operation === "resume"
          ? client.resume({
              params: { workflowId: input.workflowId },
              payload: { projectId: input.projectId },
              headers,
            })
          : client.cancel({
              params: { workflowId: input.workflowId },
              payload: { projectId: input.projectId },
              headers,
            }),
  });
});

const retryEnvironmentWorkflow = Effect.fn("retryEnvironmentWorkflow")(function* (
  input: WorkflowRequestContext & WorkflowMutationInput,
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "workflows",
    method: "POST",
    url: (base) =>
      environmentEndpointUrl(base, `/api/workflows/${encodeURIComponent(input.workflowId)}/retry`),
    timeoutMs: input.timeoutMs ?? DEFAULT_WORKFLOW_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.retry({
        params: { workflowId: input.workflowId },
        payload: { projectId: input.projectId },
        headers,
      }),
  });
});

const restartEnvironmentWorkflow = Effect.fn("restartEnvironmentWorkflow")(function* (
  input: WorkflowRequestContext & WorkflowMutationInput & { readonly fromStep: number },
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "workflows",
    method: "POST",
    url: (base) =>
      environmentEndpointUrl(
        base,
        `/api/workflows/${encodeURIComponent(input.workflowId)}/restart`,
      ),
    timeoutMs: input.timeoutMs ?? DEFAULT_WORKFLOW_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.restart({
        params: { workflowId: input.workflowId },
        payload: { projectId: input.projectId, fromStep: input.fromStep },
        headers,
      }),
  });
});

export type FetchEnvironmentWorkflowError = RemoteEnvironmentRequestError;

export function createEnvironmentWorkflowAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  const withPreparedConnection = <A, E2, R2>(
    request: (prepared: PreparedConnection) => Effect.Effect<A, E2, R2>,
  ) =>
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor;
      const prepared = yield* SubscriptionRef.get(supervisor.prepared);
      if (Option.isNone(prepared)) return yield* Effect.never;
      return yield* request(prepared.value);
    });

  const withRequestContext = <A, E2, R2>(
    request: (context: WorkflowRequestContext) => Effect.Effect<A, E2, R2>,
  ) =>
    withPreparedConnection((prepared) =>
      Effect.gen(function* () {
        const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
        const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
        return yield* request({ prepared, signer, remoteAuthorization });
      }),
    );

  const list = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:workflows:list",
    staleTimeMs: 15_000,
    refreshIntervalMs: 15_000,
    execute: (input: { readonly projectId: ProjectId }) =>
      withRequestContext((context) => fetchEnvironmentWorkflows({ ...context, ...input })),
  });
  const detail = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:workflows:detail",
    staleTimeMs: 15_000,
    refreshIntervalMs: 15_000,
    execute: (input: WorkflowMutationInput) =>
      withRequestContext((context) => fetchEnvironmentWorkflow({ ...context, ...input })),
  });

  const refreshProject = (
    registry: { refresh: (atom: ReturnType<typeof list>) => void },
    environmentId: EnvironmentId,
    projectId: ProjectId,
  ) => Effect.sync(() => registry.refresh(list({ environmentId, input: { projectId } })));

  return {
    list,
    detail,
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:workflows:create",
      execute: (input: WorkflowCreateInput, registry, environmentId) =>
        withRequestContext((context) => createEnvironmentWorkflow({ ...context, ...input })).pipe(
          Effect.tap(() => refreshProject(registry, environmentId, input.projectId)),
        ),
    }),
    pause: createEnvironmentCommand(runtime, {
      label: "environment-data:workflows:pause",
      execute: (input: WorkflowMutationInput, registry, environmentId) =>
        withRequestContext((context) =>
          changeEnvironmentWorkflowState({ ...context, ...input, operation: "pause" }),
        ).pipe(Effect.tap(() => refreshProject(registry, environmentId, input.projectId))),
    }),
    resume: createEnvironmentCommand(runtime, {
      label: "environment-data:workflows:resume",
      execute: (input: WorkflowMutationInput, registry, environmentId) =>
        withRequestContext((context) =>
          changeEnvironmentWorkflowState({ ...context, ...input, operation: "resume" }),
        ).pipe(Effect.tap(() => refreshProject(registry, environmentId, input.projectId))),
    }),
    retry: createEnvironmentCommand(runtime, {
      label: "environment-data:workflows:retry",
      execute: (input: WorkflowMutationInput, registry, environmentId) =>
        withRequestContext((context) => retryEnvironmentWorkflow({ ...context, ...input })).pipe(
          Effect.tap(() => refreshProject(registry, environmentId, input.projectId)),
        ),
    }),
    restart: createEnvironmentCommand(runtime, {
      label: "environment-data:workflows:restart",
      execute: (
        input: WorkflowMutationInput & { readonly fromStep: number },
        registry,
        environmentId,
      ) =>
        withRequestContext((context) => restartEnvironmentWorkflow({ ...context, ...input })).pipe(
          Effect.tap(() => refreshProject(registry, environmentId, input.projectId)),
        ),
    }),
    cancel: createEnvironmentCommand(runtime, {
      label: "environment-data:workflows:cancel",
      execute: (input: WorkflowMutationInput, registry, environmentId) =>
        withRequestContext((context) =>
          changeEnvironmentWorkflowState({ ...context, ...input, operation: "cancel" }),
        ).pipe(Effect.tap(() => refreshProject(registry, environmentId, input.projectId))),
    }),
  };
}
