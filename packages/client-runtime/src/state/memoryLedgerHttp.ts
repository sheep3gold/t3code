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
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand, createEnvironmentQueryAtomFamily } from "./runtime.ts";

const TIMEOUT_MS = 10_000;

type RequestContext = {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
};

export type MemoryCreateInput = {
  readonly projectId: ProjectId;
  readonly sourceThreadId: ThreadId;
  readonly kind: "lesson" | "memory";
  readonly scope: "global" | "project";
  readonly content: string;
  readonly negative?: string | null;
  readonly tags?: ReadonlyArray<string>;
};
export type MemoryUpdateInput = {
  readonly projectId: ProjectId;
  readonly memoryId: string;
  readonly content: string;
  readonly negative: string | null;
  readonly tags: ReadonlyArray<string>;
};
export type LedgerUpdateInput = {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly goal: string | null;
  readonly phase: string | null;
  readonly next: string | null;
  readonly artifacts: Readonly<Record<string, string>>;
  readonly eventKind?: string;
  readonly event?: string;
};

const fetchMemories = Effect.fn("fetchEnvironmentMemories")(function* (
  input: RequestContext & { readonly projectId: ProjectId },
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "memoryLedger",
    method: "GET",
    url: (base) => environmentEndpointUrl(base, "/api/memories"),
    timeoutMs: TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.listMemories({ payload: { projectId: input.projectId }, headers }),
  });
});

const fetchLedger = Effect.fn("fetchEnvironmentLedger")(function* (
  input: RequestContext & { readonly projectId: ProjectId; readonly threadId: ThreadId },
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "memoryLedger",
    method: "GET",
    url: (base) =>
      environmentEndpointUrl(base, `/api/ledgers/${encodeURIComponent(input.threadId)}`),
    timeoutMs: TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.getLedger({
        params: { threadId: input.threadId },
        payload: { projectId: input.projectId },
        headers,
      }),
  });
});

export function createEnvironmentMemoryLedgerAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  const withContext = <A, E2, R2>(run: (context: RequestContext) => Effect.Effect<A, E2, R2>) =>
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor;
      const prepared = yield* SubscriptionRef.get(supervisor.prepared);
      if (Option.isNone(prepared)) return yield* Effect.never;
      const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
      const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
      return yield* run({ prepared: prepared.value, signer, remoteAuthorization });
    });
  const memories = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:memories:list",
    staleTimeMs: 10_000,
    execute: (input: { readonly projectId: ProjectId }) =>
      withContext((context) => fetchMemories({ ...context, ...input })),
  });
  const ledger = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:ledgers:get",
    staleTimeMs: 10_000,
    execute: (input: { readonly projectId: ProjectId; readonly threadId: ThreadId }) =>
      withContext((context) => fetchLedger({ ...context, ...input })),
  });
  const refreshMemories = (
    registry: { refresh: (atom: ReturnType<typeof memories>) => void },
    environmentId: EnvironmentId,
    projectId: ProjectId,
  ) => Effect.sync(() => registry.refresh(memories({ environmentId, input: { projectId } })));
  const refreshLedger = (
    registry: { refresh: (atom: ReturnType<typeof ledger>) => void },
    environmentId: EnvironmentId,
    input: { readonly projectId: ProjectId; readonly threadId: ThreadId },
  ) =>
    Effect.sync(() =>
      registry.refresh(
        ledger({
          environmentId,
          input: { projectId: input.projectId, threadId: input.threadId },
        }),
      ),
    );

  return {
    memories,
    ledger,
    createMemory: createEnvironmentCommand(runtime, {
      label: "environment-data:memories:create",
      execute: (input: MemoryCreateInput, registry, environmentId) =>
        withContext((context) =>
          executeAuthenticatedEnvironmentHttpRequest({
            ...context,
            group: "memoryLedger",
            method: "POST",
            url: (base) => environmentEndpointUrl(base, "/api/memories"),
            timeoutMs: TIMEOUT_MS,
            request: ({ client, headers }) =>
              client.createMemory({
                payload: { ...input, tags: [...(input.tags ?? [])] },
                headers,
              }),
          }),
        ).pipe(Effect.tap(() => refreshMemories(registry, environmentId, input.projectId))),
    }),
    updateMemory: createEnvironmentCommand(runtime, {
      label: "environment-data:memories:update",
      execute: (input: MemoryUpdateInput, registry, environmentId) =>
        withContext((context) =>
          executeAuthenticatedEnvironmentHttpRequest({
            ...context,
            group: "memoryLedger",
            method: "PATCH",
            url: (base) =>
              environmentEndpointUrl(base, `/api/memories/${encodeURIComponent(input.memoryId)}`),
            timeoutMs: TIMEOUT_MS,
            request: ({ client, headers }) =>
              client.updateMemory({
                params: { memoryId: input.memoryId },
                payload: {
                  projectId: input.projectId,
                  content: input.content,
                  negative: input.negative,
                  tags: [...input.tags],
                },
                headers,
              }),
          }),
        ).pipe(Effect.tap(() => refreshMemories(registry, environmentId, input.projectId))),
    }),
    removeMemory: createEnvironmentCommand(runtime, {
      label: "environment-data:memories:remove",
      execute: (
        input: { readonly projectId: ProjectId; readonly memoryId: string },
        registry,
        environmentId,
      ) =>
        withContext((context) =>
          executeAuthenticatedEnvironmentHttpRequest({
            ...context,
            group: "memoryLedger",
            method: "DELETE",
            url: (base) =>
              environmentEndpointUrl(base, `/api/memories/${encodeURIComponent(input.memoryId)}`),
            timeoutMs: TIMEOUT_MS,
            request: ({ client, headers }) =>
              client.removeMemory({
                params: { memoryId: input.memoryId },
                payload: { projectId: input.projectId },
                headers,
              }),
          }),
        ).pipe(Effect.tap(() => refreshMemories(registry, environmentId, input.projectId))),
    }),
    updateLedger: createEnvironmentCommand(runtime, {
      label: "environment-data:ledgers:update",
      execute: (input: LedgerUpdateInput, registry, environmentId) =>
        withContext((context) =>
          executeAuthenticatedEnvironmentHttpRequest({
            ...context,
            group: "memoryLedger",
            method: "PUT",
            url: (base) =>
              environmentEndpointUrl(base, `/api/ledgers/${encodeURIComponent(input.threadId)}`),
            timeoutMs: TIMEOUT_MS,
            request: ({ client, headers }) =>
              client.updateLedger({
                params: { threadId: input.threadId },
                payload: { ...input, artifacts: { ...input.artifacts } },
                headers,
              }),
          }),
        ).pipe(Effect.tap(() => refreshLedger(registry, environmentId, input))),
    }),
    clearLedger: createEnvironmentCommand(runtime, {
      label: "environment-data:ledgers:clear",
      execute: (
        input: { readonly projectId: ProjectId; readonly threadId: ThreadId },
        registry,
        environmentId,
      ) =>
        withContext((context) =>
          executeAuthenticatedEnvironmentHttpRequest({
            ...context,
            group: "memoryLedger",
            method: "DELETE",
            url: (base) =>
              environmentEndpointUrl(base, `/api/ledgers/${encodeURIComponent(input.threadId)}`),
            timeoutMs: TIMEOUT_MS,
            request: ({ client, headers }) =>
              client.clearLedger({
                params: { threadId: input.threadId },
                payload: { projectId: input.projectId },
                headers,
              }),
          }),
        ).pipe(Effect.tap(() => refreshLedger(registry, environmentId, input))),
    }),
  };
}
