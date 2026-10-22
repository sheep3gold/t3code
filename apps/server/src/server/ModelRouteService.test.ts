import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ModelRouteService from "./ModelRouteService.ts";

const makeMockLayer = (
  handler: (request: { readonly url: string; readonly method: string }) => Response,
) =>
  ModelRouteService.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => HttpClientResponse.fromWeb(request, handler(request))),
        ),
      ),
    ),
  );

const GATEWAY_BODY = JSON.stringify({
  session_key: "sk-test-123",
  tier: "MEDIUM",
  base_tier: "LOW",
  provider: "glm",
  model: "glm-5.3",
  deployment: "glm-prod",
  last_status: "active",
  ts: 1_700_000_000,
});

describe("ModelRouteService", () => {
  it.effect("parses a successful gateway response into the camelCase shape", () => {
    const layer = makeMockLayer(
      () =>
        new Response(GATEWAY_BODY, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    return Effect.gen(function* () {
      const service = yield* ModelRouteService.ModelRouteService;
      const result = yield* service.getModelRoute({ providerSessionId: "ps-abc" });

      assert.strictEqual(result.sessionKey, "sk-test-123");
      assert.strictEqual(result.tier, "MEDIUM");
      assert.strictEqual(result.baseTier, "LOW");
      assert.strictEqual(result.provider, "glm");
      assert.strictEqual(result.model, "glm-5.3");
      assert.strictEqual(result.deployment, "glm-prod");
      assert.strictEqual(result.lastStatus, "active");
      assert.strictEqual(result.ts, 1_700_000_000);
    }).pipe(Effect.provide(layer));
  });

  it.effect("defaults optional gateway fields when omitted", () => {
    const layer = makeMockLayer(
      () =>
        new Response(JSON.stringify({ provider: "glm", model: "glm-5.3", tier: "HIGH" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    return Effect.gen(function* () {
      const service = yield* ModelRouteService.ModelRouteService;
      const result = yield* service.getModelRoute({ providerSessionId: "ps-def" });

      assert.strictEqual(result.sessionKey, "");
      assert.strictEqual(result.tier, "HIGH");
      assert.strictEqual(result.baseTier, "");
      assert.strictEqual(result.deployment, "");
      assert.strictEqual(result.lastStatus, "");
      assert.strictEqual(result.ts, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with ModelRouteError when gateway returns non-OK status", () => {
    const layer = makeMockLayer(() => new Response("not found", { status: 404 }));
    return Effect.gen(function* () {
      const service = yield* ModelRouteService.ModelRouteService;
      const error = yield* Effect.flip(service.getModelRoute({ providerSessionId: "ps-404" }));
      assert.strictEqual(error._tag, "ModelRouteError");
      assert.strictEqual(error.reason, "gateway_request_failed");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with ModelRouteError when response is not valid JSON", () => {
    const layer = makeMockLayer(
      () => new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    return Effect.gen(function* () {
      const service = yield* ModelRouteService.ModelRouteService;
      const error = yield* Effect.flip(service.getModelRoute({ providerSessionId: "ps-bad" }));
      assert.strictEqual(error._tag, "ModelRouteError");
      assert.strictEqual(error.reason, "invalid_gateway_response");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with ModelRouteError when required fields are missing", () => {
    const layer = makeMockLayer(
      () =>
        new Response(JSON.stringify({ tier: "MEDIUM" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    return Effect.gen(function* () {
      const service = yield* ModelRouteService.ModelRouteService;
      const error = yield* Effect.flip(service.getModelRoute({ providerSessionId: "ps-missing" }));
      assert.strictEqual(error._tag, "ModelRouteError");
      assert.strictEqual(error.reason, "invalid_gateway_response");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with ModelRouteError when gateway returns an error field", () => {
    const layer = makeMockLayer(
      () =>
        new Response(
          JSON.stringify({ provider: "glm", model: "glm-5.3", tier: "HIGH", error: "not_found" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    return Effect.gen(function* () {
      const service = yield* ModelRouteService.ModelRouteService;
      const error = yield* Effect.flip(service.getModelRoute({ providerSessionId: "ps-err" }));
      assert.strictEqual(error._tag, "ModelRouteError");
      assert.strictEqual(error.reason, "gateway_error_response");
    }).pipe(Effect.provide(layer));
  });
});
