import {
  AuthOrchestrationOperateScope,
  ForkTranslationHttpApi,
  EnvironmentTranslatePayload,
  EnvironmentTranslateUpstreamError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as Translation from "./Translation.ts";

const decodePayload = Schema.decodeUnknownEffect(EnvironmentTranslatePayload);

const handlers = HttpApiBuilder.group(
  ForkTranslationHttpApi,
  "translate",
  Effect.fnUntraced(function* (handlers) {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const translation = yield* Translation.Translation;
    return handlers.handleRaw(
      "translate",
      Effect.fn("environment.translate.translate")(function* ({ request }) {
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
          return yield* failEnvironmentScopeRequired(AuthOrchestrationOperateScope);
        }

        // Authenticate before consuming the body, including desktop wsTicket credentials.
        const body = yield* request.json.pipe(
          Effect.mapError(
            () => new EnvironmentTranslateUpstreamError({ message: "Invalid JSON body." }),
          ),
        );
        const input = yield* decodePayload(body).pipe(
          Effect.mapError(
            () =>
              new EnvironmentTranslateUpstreamError({ message: "Expected { texts: string[] }." }),
          ),
        );
        return yield* translation.translate(input.texts);
      }),
    );
  }),
);
export const layer = HttpApiBuilder.layer(ForkTranslationHttpApi).pipe(
  Layer.provide(handlers),
  Layer.provide(Translation.layer),
);
