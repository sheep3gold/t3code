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

const DEFAULT_SCHEDULE_TIMEOUT_MS = 10_000;

type ScheduleRequestContext = {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
};

type ScheduleCreateInput = {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly prompt: string;
  readonly at?: string;
  readonly delaySeconds?: number;
  readonly everySeconds?: number;
};

export const fetchEnvironmentSchedules = Effect.fn("fetchEnvironmentSchedules")(function* (
  input: ScheduleRequestContext & { readonly projectId: ProjectId },
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "schedules",
    method: "GET",
    url: (base) => environmentEndpointUrl(base, "/api/schedules"),
    timeoutMs: input.timeoutMs ?? DEFAULT_SCHEDULE_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.list({ payload: { projectId: input.projectId }, headers }),
  });
});

export const createEnvironmentSchedule = Effect.fn("createEnvironmentSchedule")(function* (
  input: ScheduleRequestContext & ScheduleCreateInput,
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "schedules",
    method: "POST",
    url: (base) => environmentEndpointUrl(base, "/api/schedules"),
    timeoutMs: input.timeoutMs ?? DEFAULT_SCHEDULE_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.create({
        payload: {
          projectId: input.projectId,
          threadId: input.threadId,
          prompt: input.prompt,
          ...(input.at === undefined ? {} : { at: input.at }),
          ...(input.delaySeconds === undefined ? {} : { delaySeconds: input.delaySeconds }),
          ...(input.everySeconds === undefined ? {} : { everySeconds: input.everySeconds }),
        },
        headers,
      }),
  });
});

type ScheduleMutationInput = ScheduleRequestContext & {
  readonly projectId: ProjectId;
  readonly scheduleId: string;
};

const mutateEnvironmentSchedule = Effect.fn("mutateEnvironmentSchedule")(function* (
  input: ScheduleMutationInput & {
    readonly operation: "pause" | "resume" | "remove";
  },
) {
  const suffix = input.operation === "remove" ? "" : `/${input.operation}`;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "schedules",
    method: input.operation === "remove" ? "DELETE" : "POST",
    url: (base) =>
      environmentEndpointUrl(
        base,
        `/api/schedules/${encodeURIComponent(input.scheduleId)}${suffix}`,
      ),
    timeoutMs: input.timeoutMs ?? DEFAULT_SCHEDULE_TIMEOUT_MS,
    request: ({ client, headers }) =>
      input.operation === "pause"
        ? client.pause({
            params: { scheduleId: input.scheduleId },
            payload: { projectId: input.projectId },
            headers,
          })
        : input.operation === "resume"
          ? client.resume({
              params: { scheduleId: input.scheduleId },
              payload: { projectId: input.projectId },
              headers,
            })
          : client.remove({
              params: { scheduleId: input.scheduleId },
              payload: { projectId: input.projectId },
              headers,
            }),
  });
});

export const pauseEnvironmentSchedule = (input: ScheduleMutationInput) =>
  mutateEnvironmentSchedule({ ...input, operation: "pause" });

export const resumeEnvironmentSchedule = (input: ScheduleMutationInput) =>
  mutateEnvironmentSchedule({ ...input, operation: "resume" });

export const removeEnvironmentSchedule = (input: ScheduleMutationInput) =>
  mutateEnvironmentSchedule({ ...input, operation: "remove" });

export type FetchEnvironmentScheduleError = RemoteEnvironmentRequestError;

export function createEnvironmentScheduleAtoms<R, E>(
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

  const list = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:schedules:list",
    staleTimeMs: 15_000,
    refreshIntervalMs: 15_000,
    execute: (input: { readonly projectId: ProjectId }) =>
      withPreparedConnection((prepared) =>
        Effect.gen(function* () {
          const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
          const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
          return yield* fetchEnvironmentSchedules({
            prepared,
            projectId: input.projectId,
            signer,
            remoteAuthorization,
          });
        }),
      ),
  });

  const refreshProject = (
    registry: { refresh: (atom: ReturnType<typeof list>) => void },
    environmentId: EnvironmentId,
    projectId: ProjectId,
  ) => Effect.sync(() => registry.refresh(list({ environmentId, input: { projectId } })));

  const withRequestContext = <A, E2, R2>(
    request: (context: ScheduleRequestContext) => Effect.Effect<A, E2, R2>,
  ) =>
    withPreparedConnection((prepared) =>
      Effect.gen(function* () {
        const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
        const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
        return yield* request({ prepared, signer, remoteAuthorization });
      }),
    );

  return {
    list,
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:schedules:create",
      execute: (input: ScheduleCreateInput, registry, environmentId) =>
        withRequestContext((context) => createEnvironmentSchedule({ ...context, ...input })).pipe(
          Effect.tap(() => refreshProject(registry, environmentId, input.projectId)),
        ),
    }),
    pause: createEnvironmentCommand(runtime, {
      label: "environment-data:schedules:pause",
      execute: (
        input: Omit<ScheduleMutationInput, keyof ScheduleRequestContext>,
        registry,
        environmentId,
      ) =>
        withRequestContext((context) => pauseEnvironmentSchedule({ ...context, ...input })).pipe(
          Effect.tap(() => refreshProject(registry, environmentId, input.projectId)),
        ),
    }),
    resume: createEnvironmentCommand(runtime, {
      label: "environment-data:schedules:resume",
      execute: (
        input: Omit<ScheduleMutationInput, keyof ScheduleRequestContext>,
        registry,
        environmentId,
      ) =>
        withRequestContext((context) => resumeEnvironmentSchedule({ ...context, ...input })).pipe(
          Effect.tap(() => refreshProject(registry, environmentId, input.projectId)),
        ),
    }),
    remove: createEnvironmentCommand(runtime, {
      label: "environment-data:schedules:remove",
      execute: (
        input: Omit<ScheduleMutationInput, keyof ScheduleRequestContext>,
        registry,
        environmentId,
      ) =>
        withRequestContext((context) => removeEnvironmentSchedule({ ...context, ...input })).pipe(
          Effect.tap(() => refreshProject(registry, environmentId, input.projectId)),
        ),
    }),
  };
}
