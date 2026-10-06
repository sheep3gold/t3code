import type { EnvironmentId } from "@t3tools/contracts";
import { EnvironmentTranslateUnavailableError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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
import { createEnvironmentCommand } from "./runtime.ts";

// Translation streams a long upstream chat completion; the server can spend up
// to 60s per chunk batch, so the client budget must exceed one full batch.
const DEFAULT_TRANSLATE_TIMEOUT_MS = 120_000;

type TranslateRequestContext = {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
};

export type TranslateEnvironmentError = RemoteEnvironmentRequestError;

export const translateEnvironmentTexts = Effect.fn("translateEnvironmentTexts")(function* (
  input: TranslateRequestContext & { readonly texts: ReadonlyArray<string> },
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "translate",
    method: "POST",
    url: (base) => environmentEndpointUrl(base, "/api/translate"),
    timeoutMs: input.timeoutMs ?? DEFAULT_TRANSLATE_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.translate({ payload: { texts: [...input.texts] }, headers }),
  });
});

export function createEnvironmentTranslateAtoms<R, E>(
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
    request: (context: TranslateRequestContext) => Effect.Effect<A, E2, R2>,
  ) =>
    withPreparedConnection((prepared) =>
      Effect.gen(function* () {
        const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
        const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
        return yield* request({ prepared, signer, remoteAuthorization });
      }),
    );

  return {
    translate: createEnvironmentCommand(runtime, {
      label: "environment-data:translate:translate",
      execute: (input: { readonly texts: ReadonlyArray<string> }, _registry, _environmentId) =>
        withRequestContext((context) => translateEnvironmentTexts({ ...context, ...input })),
    }),
  };
}

export const isTranslateUnavailable = Schema.is(EnvironmentTranslateUnavailableError);

export type { EnvironmentId };
