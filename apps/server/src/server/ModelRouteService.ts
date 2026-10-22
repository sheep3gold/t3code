import type { ServerModelRouteInfo } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

export class ModelRouteError extends Schema.TaggedError<ModelRouteError>()("ModelRouteError", {
  providerSessionId: Schema.String,
  reason: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to resolve model route for session "${this.providerSessionId}": ${this.reason}`;
  }
}

export const isModelRouteError = Schema.is(ModelRouteError);

const GatewaySessionRouteResponse = Schema.Struct({
  session_key: Schema.optional(Schema.String),
  tier: Schema.String,
  base_tier: Schema.optional(Schema.String),
  provider: Schema.String,
  model: Schema.String,
  deployment: Schema.optional(Schema.String),
  last_status: Schema.optional(Schema.String),
  ts: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.Unknown),
});

const decodeGatewayResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GatewaySessionRouteResponse),
);

const GATEWAY_URL = "https://llm.zxytech.cn/v1";
const GATEWAY_TIMEOUT = Duration.seconds(2);

export class ModelRouteService extends Context.Service<
  ModelRouteService,
  {
    readonly getModelRoute: (input: {
      readonly providerSessionId: string;
    }) => Effect.Effect<ServerModelRouteInfo, ModelRouteError>;
  }
>()("t3/server/ModelRouteService") {}

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  const getModelRoute = Effect.fn("ModelRouteService.getModelRoute")(function* (input: {
    readonly providerSessionId: string;
  }) {
    const url = `${GATEWAY_URL.replace(/\/$/, "")}/session/by-id/${encodeURIComponent(input.providerSessionId)}`;

    const body = yield* httpClient
      .execute(
        HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader("Accept", "application/json")),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.text),
        Effect.timeoutOrElse({
          duration: GATEWAY_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new ModelRouteError({
                providerSessionId: input.providerSessionId,
                reason: "gateway_timeout",
                cause: new Error("Gateway request timed out"),
              }),
            ),
        }),
        Effect.mapError((cause) =>
          isModelRouteError(cause)
            ? cause
            : new ModelRouteError({
                providerSessionId: input.providerSessionId,
                reason: "gateway_request_failed",
                cause,
              }),
        ),
      );

    const data = yield* decodeGatewayResponse(body).pipe(
      Effect.mapError(
        (cause) =>
          new ModelRouteError({
            providerSessionId: input.providerSessionId,
            reason: "invalid_gateway_response",
            cause,
          }),
      ),
    );

    if (data.error !== undefined && data.error !== null) {
      return yield* new ModelRouteError({
        providerSessionId: input.providerSessionId,
        reason: "gateway_error_response",
        cause: new Error("Gateway returned an error response"),
      });
    }

    return {
      sessionKey: data.session_key ?? "",
      tier: data.tier,
      baseTier: data.base_tier ?? "",
      provider: data.provider,
      model: data.model,
      deployment: data.deployment ?? "",
      lastStatus: data.last_status ?? "",
      ts: data.ts ?? 0,
    } satisfies ServerModelRouteInfo;
  });

  return ModelRouteService.of({ getModelRoute });
});

export const layer = Layer.effect(ModelRouteService, make);
