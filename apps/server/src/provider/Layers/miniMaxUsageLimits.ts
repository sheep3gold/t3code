import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const TOKEN_PLAN_REMAINS_URL = "https://www.minimax.io/v1/token_plan/remains";

// This endpoint is not a documented MiniMax public API. Keep its tolerant
// envelope isolated here so a provider-side response change becomes a visible
// probe failure rather than an invented zero quota.
const ModelRemain = Schema.Struct({
  model_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  current_interval_usage_count: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  current_interval_total_count: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  current_interval_remaining_percent: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  current_weekly_remaining_percent: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  end_time: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
});
const TokenPlanResponse = Schema.Struct({
  model_remains: Schema.optionalKey(Schema.Array(ModelRemain)),
});

function usagePercent(input: {
  readonly used: number | null | undefined;
  readonly total: number | null | undefined;
  readonly remaining: number | null | undefined;
}): number | undefined {
  if (typeof input.used === "number" && typeof input.total === "number" && input.total > 0) {
    return clampPercent((input.used / input.total) * 100);
  }
  if (typeof input.remaining === "number") {
    return clampPercent(100 - input.remaining);
  }
  return undefined;
}

function resetAt(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  // MiniMax has returned both epoch seconds and milliseconds across clients.
  const millis = value > 100_000_000_000 ? value : value * 1000;
  const dateTime = DateTime.make(millis);
  return Option.isSome(dateTime) ? DateTime.formatIso(dateTime.value) : undefined;
}

function modelKey(name: string, index: number): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return normalized || `model_${index + 1}`;
}

function windowsFromResponse(response: typeof TokenPlanResponse.Type): ReadonlyArray<ServerProviderUsageWindow> {
  const windows: ServerProviderUsageWindow[] = [];
  for (const [index, model] of (response.model_remains ?? []).entries()) {
    const name = model.model_name?.trim() || `Model ${index + 1}`;
    const key = modelKey(name, index);
    const intervalPercent = usagePercent({
      used: model.current_interval_usage_count,
      total: model.current_interval_total_count,
      remaining: model.current_interval_remaining_percent,
    });
    if (intervalPercent !== undefined) {
      const resetsAt = resetAt(model.end_time);
      windows.push({
        id: `minimax_${key}_interval`,
        kind: "other",
        label: `${name} · Current period`,
        usedPercent: intervalPercent,
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
    const weeklyPercent = usagePercent({
      used: undefined,
      total: undefined,
      remaining: model.current_weekly_remaining_percent,
    });
    if (weeklyPercent !== undefined) {
      windows.push({
        id: `minimax_${key}_weekly`,
        kind: "weekly",
        label: `${name} · Weekly`,
        usedPercent: weeklyPercent,
      });
    }
  }
  return windows;
}

/** Read MiniMax Token Plan windows using only an explicitly configured sensitive environment key. */
export const readMiniMaxTokenPlanUsageLimits = Effect.fn("readMiniMaxTokenPlanUsageLimits")(function* (input: {
  readonly enabled: boolean;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  const token = input.environment.MINIMAX_TOKEN_PLAN_KEY?.trim();
  if (!input.enabled || !token) return unsupported;

  return yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(TOKEN_PLAN_REMAINS_URL).pipe(HttpClientRequest.bearerToken(token)),
    );
    const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenPlanResponse)),
    );
    const windows = windowsFromResponse(body);
    if (windows.length === 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "MiniMax Token Plan did not report quota windows.",
      });
    }
    return makeUsageLimits({ checkedAt, windows });
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "MiniMax Token Plan could not read usage.",
      }),
    ),
  );
});
