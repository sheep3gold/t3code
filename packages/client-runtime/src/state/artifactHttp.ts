import type {
  EnvironmentArtifactDetail,
  EnvironmentArtifactSummary,
  EnvironmentArtifactVersion,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

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
  }) as { readonly artifacts: ReadonlyArray<EnvironmentArtifactSummary> };
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
  }) as EnvironmentArtifactDetail;
});

export const fetchEnvironmentArtifactVersions = Effect.fn(
  "fetchEnvironmentArtifactVersions",
)(function* (
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
  }) as { readonly versions: ReadonlyArray<EnvironmentArtifactVersion> };
});

export type FetchEnvironmentArtifactError = RemoteEnvironmentRequestError;
