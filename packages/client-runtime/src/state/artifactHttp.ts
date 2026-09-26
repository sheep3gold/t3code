import type { ProjectId } from "@t3tools/contracts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { type Atom } from "effect/unstable/reactivity";
import { HttpClient } from "effect/unstable/http";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const DEFAULT_ARTIFACT_TIMEOUT_MS = 10_000;

type ArtifactRequestContext = {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
};

export const fetchEnvironmentArtifacts = Effect.fn("fetchEnvironmentArtifacts")(function* (
  input: ArtifactRequestContext & { readonly projectId: ProjectId },
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "artifacts",
    method: "GET",
    url: (base) => environmentEndpointUrl(base, "/api/artifacts"),
    timeoutMs: input.timeoutMs ?? DEFAULT_ARTIFACT_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.list({ payload: { projectId: input.projectId }, headers }),
  });
});

export const fetchEnvironmentArtifact = Effect.fn("fetchEnvironmentArtifact")(function* (
  input: ArtifactRequestContext & {
    readonly projectId: ProjectId;
    readonly slug: string;
    readonly version?: number;
  },
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "artifacts",
    method: "GET",
    url: (base) => environmentEndpointUrl(base, `/api/artifacts/${encodeURIComponent(input.slug)}`),
    timeoutMs: input.timeoutMs ?? DEFAULT_ARTIFACT_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.get({
        params: { slug: input.slug },
        payload: {
          projectId: input.projectId,
          ...(input.version === undefined ? {} : { version: input.version }),
        },
        headers,
      }),
  });
});

export const fetchEnvironmentArtifactVersions = Effect.fn("fetchEnvironmentArtifactVersions")(
  function* (
    input: ArtifactRequestContext & { readonly projectId: ProjectId; readonly slug: string },
  ) {
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "artifacts",
      method: "GET",
      url: (base) =>
        environmentEndpointUrl(base, `/api/artifacts/${encodeURIComponent(input.slug)}/versions`),
      timeoutMs: input.timeoutMs ?? DEFAULT_ARTIFACT_TIMEOUT_MS,
      request: ({ client, headers }) =>
        client.versions({
          params: { slug: input.slug },
          payload: { projectId: input.projectId },
          headers,
        }),
    });
  },
);

export type FetchEnvironmentArtifactError = RemoteEnvironmentRequestError;

export function createEnvironmentArtifactAtoms<R, E>(
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

  return {
    list: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:artifacts:list",
      staleTimeMs: 30_000,
      execute: (input: { readonly projectId: ProjectId }) =>
        withPreparedConnection((prepared) =>
          Effect.gen(function* () {
            const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
            const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
            return yield* fetchEnvironmentArtifacts({
              prepared,
              projectId: input.projectId,
              signer,
              remoteAuthorization,
            });
          }),
        ),
    }),
    detail: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:artifacts:detail",
      staleTimeMs: 30_000,
      execute: (input: {
        readonly projectId: ProjectId;
        readonly slug: string;
        readonly version?: number;
      }) =>
        withPreparedConnection((prepared) =>
          Effect.gen(function* () {
            const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
            const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
            return yield* fetchEnvironmentArtifact({
              prepared,
              projectId: input.projectId,
              slug: input.slug,
              signer,
              remoteAuthorization,
              ...(input.version === undefined ? {} : { version: input.version }),
            });
          }),
        ),
    }),
    versions: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:artifacts:versions",
      staleTimeMs: 30_000,
      execute: (input: { readonly projectId: ProjectId; readonly slug: string }) =>
        withPreparedConnection((prepared) =>
          Effect.gen(function* () {
            const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
            const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
            return yield* fetchEnvironmentArtifactVersions({
              prepared,
              projectId: input.projectId,
              slug: input.slug,
              signer,
              remoteAuthorization,
            });
          }),
        ),
    }),
  };
}
