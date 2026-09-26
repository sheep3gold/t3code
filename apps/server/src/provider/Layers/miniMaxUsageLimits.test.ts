import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { readMiniMaxTokenPlanUsageLimits } from "./miniMaxUsageLimits.ts";

it.effect("maps MiniMax current and weekly Token Plan windows without leaking the key", () =>
  Effect.gen(function* () {
    const limits = yield* readMiniMaxTokenPlanUsageLimits({
      enabled: true,
      environment: { MINIMAX_TOKEN_PLAN_KEY: "test-token" },
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          NodeAssert.equal(request.url, "https://www.minimax.io/v1/token_plan/remains");
          NodeAssert.equal(request.headers.authorization, "Bearer test-token");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                model_remains: [
                  {
                    model_name: "MiniMax-M3",
                    current_interval_usage_count: 25,
                    current_interval_total_count: 100,
                    current_weekly_remaining_percent: 80,
                    end_time: 1_788_000_000,
                  },
                ],
              }),
            ),
          );
        }),
      ),
      Effect.provide(NodeServices.layer),
    );
    NodeAssert.equal(limits.unavailable, undefined);
    NodeAssert.deepEqual(
      limits.windows.map(({ id, kind, usedPercent, resetsAt }) => ({ id, kind, usedPercent, resetsAt })),
      [
        { id: "minimax_minimax_m3_weekly", kind: "weekly", usedPercent: 20, resetsAt: undefined },
        {
          id: "minimax_minimax_m3_interval",
          kind: "other",
          usedPercent: 25,
          resetsAt: "2026-08-29T10:40:00.000Z",
        },
      ],
    );
  }),
);

it.effect("does not request MiniMax usage without an explicit Token Plan key", () =>
  Effect.gen(function* () {
    const limits = yield* readMiniMaxTokenPlanUsageLimits({ enabled: true, environment: {} }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("usage request must not run without a key")),
      ),
      Effect.provide(NodeServices.layer),
    );
    NodeAssert.equal(limits.unavailable?.reason, "unsupported");
  }),
);

it.effect("reports endpoint and response failures instead of treating them as empty quota", () =>
  Effect.gen(function* () {
    for (const response of [Response.json({}, { status: 401 }), Response.json({ model_remains: [] })]) {
      const limits = yield* readMiniMaxTokenPlanUsageLimits({
        enabled: true,
        environment: { MINIMAX_TOKEN_PLAN_KEY: "test-token" },
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response))),
        ),
        Effect.provide(NodeServices.layer),
      );
      NodeAssert.equal(limits.unavailable?.reason, "probeFailed");
      NodeAssert.deepEqual(limits.windows, []);
    }
  }),
);
