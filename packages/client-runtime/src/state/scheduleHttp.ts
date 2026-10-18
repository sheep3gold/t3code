import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { createEnvironmentCommand, createEnvironmentQueryAtomFamily } from "./runtime.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { type Atom } from "effect/reactivity";
import { HttpClient } from "effect/http";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const DEFAULT_SCHEDULE_TIMEOUT_MS = 10_000;

type ScheduleRequestContext = {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
};

export type ScheduleCreateInput = {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly prompt: string;
  readonly at?: string;
  readonly delaySeconds?: number;
  readonly everySeconds?: number;
  readonly cronExpression?: string;
  readonly timezone?: string;
  readonly skipDates?: ReadonlyArray<string>;
};

const fetchEnvironmentSchedules = Effect.fn("fetchEnvironmentSchedules")(function* (
  input: ScheduleRequestContext & { readonly projectId: ProjectId },
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "schedules",
    method: "GET",
    url: (urls) => urls.list(),
    timeoutMs: input.timeoutMs ?? DEFAULT_SCHEDULE_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.list({ payload: { projectId: input.projectId }, headers }),
  });
});

const createEnvironmentSchedule = Effect.fn("createEnvironmentSchedule")(function* (
  input: ScheduleRequestContext & ScheduleCreateInput,
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "schedules",
    method: "POST",
    url: (urls) => urls.create(),
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
          ...(input.cronExpression === undefined ? {} : { cronExpression: input.cronExpression }),
          ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
          ...(input.skipDates === undefined ? {} : { skipDates: [...input.skipDates] }),
        },
        headers,
      }),
  });
});

export type ScheduleMutationInput = {
  readonly projectId: ProjectId;
  readonly scheduleId: string;
};

type ScheduleMutationRequest = ScheduleRequestContext & ScheduleMutationInput;

const mutateEnvironmentSchedule = Effect.fn("mutateEnvironmentSchedule")(function* (
  input: ScheduleMutationRequest & {
    readonly operation: "pause" | "resume" | "remove";
  },
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "schedules",
    method: input.operation === "remove" ? "DELETE" : "POST",
    url: (urls) =>
      input.operation === "pause"
        ? urls.pause({ params: { scheduleId: input.scheduleId } })
        : input.operation === "resume"
          ? urls.resume({ params: { scheduleId: input.scheduleId } })
          : urls.remove({ params: { scheduleId: input.scheduleId } }),
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

const pauseEnvironmentSchedule = (input: ScheduleMutationRequest) =>
  mutateEnvironmentSchedule({ ...input, operation: "pause" });

const resumeEnvironmentSchedule = (input: ScheduleMutationRequest) =>
  mutateEnvironmentSchedule({ ...input, operation: "resume" });

const removeEnvironmentSchedule = (input: ScheduleMutationRequest) =>
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

  const list = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:schedules:list",
    staleTimeMs: 15_000,
    refreshIntervalMs: 15_000,
    execute: (input: { readonly projectId: ProjectId }) =>
      withRequestContext((context) => fetchEnvironmentSchedules({ ...context, ...input })),
  });

  const refreshProject = (
    registry: { refresh: (atom: ReturnType<typeof list>) => void },
    environmentId: EnvironmentId,
    projectId: ProjectId,
  ) => Effect.sync(() => registry.refresh(list({ environmentId, input: { projectId } })));

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
      execute: (input: ScheduleMutationInput, registry, environmentId) =>
        withRequestContext((context) => pauseEnvironmentSchedule({ ...context, ...input })).pipe(
          Effect.tap(() => refreshProject(registry, environmentId, input.projectId)),
        ),
    }),
    resume: createEnvironmentCommand(runtime, {
      label: "environment-data:schedules:resume",
      execute: (input: ScheduleMutationInput, registry, environmentId) =>
        withRequestContext((context) => resumeEnvironmentSchedule({ ...context, ...input })).pipe(
          Effect.tap(() => refreshProject(registry, environmentId, input.projectId)),
        ),
    }),
    remove: createEnvironmentCommand(runtime, {
      label: "environment-data:schedules:remove",
      execute: (input: ScheduleMutationInput, registry, environmentId) =>
        withRequestContext((context) => removeEnvironmentSchedule({ ...context, ...input })).pipe(
          Effect.tap(() => refreshProject(registry, environmentId, input.projectId)),
        ),
    }),
  };
}
