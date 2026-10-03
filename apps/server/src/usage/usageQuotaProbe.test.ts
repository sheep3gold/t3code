import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import { clearUsageQuotaProbeCache, readInstanceUsageLimits } from "./usageQuotaProbe.ts";

const layers = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

describe("usageQuotaProbe", () => {
  it.live("returns undefined for instances without a probe", () =>
    Effect.gen(function* () {
      const settings = { providerInstances: {} } as never;
      assert.isUndefined(yield* readInstanceUsageLimits(settings, "codex_xjp"));
      assert.isUndefined(yield* readInstanceUsageLimits(settings, "minimax"));
      assert.isUndefined(yield* readInstanceUsageLimits(settings, "claude_deepseek"));
    }).pipe(Effect.provide(layers)),
  );

  it.live("workbuddy probe resolves to a well-formed points-pool window", () =>
    Effect.gen(function* () {
      clearUsageQuotaProbeCache();
      const settings = {
        providerInstances: { codex_workbuddy: { driver: "codex" } },
      } as never;
      const limits = yield* readInstanceUsageLimits(settings, "codex_workbuddy");
      assert.isDefined(limits);
      assert.isString(limits?.checkedAt);
      if (limits?.unavailable) {
        assert.strictEqual(limits.unavailable.reason, "probeFailed");
        return;
      }
      assert.strictEqual(limits?.windows.length, 1);
      const window = limits?.windows[0];
      assert.strictEqual(window?.id, "points_pool");
      assert.strictEqual(window?.remainingUnit, "积分");
      assert.isNumber(window?.remaining);

      // The second read must come from the cache, byte-identical.
      const cached = yield* readInstanceUsageLimits(settings, "codex_workbuddy");
      assert.deepStrictEqual(cached, limits);
    }).pipe(Effect.provide(layers)),
  );
});
