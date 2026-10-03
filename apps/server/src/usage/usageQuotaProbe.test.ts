import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";

import { clearUsageQuotaProbeCache, readInstanceUsageLimits } from "./usageQuotaProbe.ts";

const layers = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

/** HttpClient answering every request with `body`, recording the URLs hit. */
const stubClient = (
  body: unknown,
  requests: Array<{ url: string; authorization?: string | undefined }>,
) =>
  Layer.merge(
    NodeServices.layer,
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push({
          url: request.url,
          authorization: request.headers.authorization,
        });
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body))),
        );
      }),
    ),
  );

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

  it.live("kimi probe reports the prepaid balance with its cash/voucher split", () => {
    const requests: Array<{ url: string; authorization?: string | undefined }> = [];
    return Effect.gen(function* () {
      clearUsageQuotaProbeCache();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(
        path.join(home, "settings.json"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off - fixture file, not a decoded value.
        JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-test" } }),
      );
      const settings = {
        providerInstances: { claude_kimi: { driver: "claudeAgent", config: { homePath: home } } },
      } as never;
      const limits = yield* readInstanceUsageLimits(settings, "claude_kimi");
      assert.isUndefined(limits?.unavailable);
      const window = limits?.windows[0];
      assert.strictEqual(window?.id, "balance");
      assert.strictEqual(window?.remaining, 59.09);
      assert.strictEqual(window?.remainingUnit, "元");
      assert.include(window?.label ?? "", "现金 47.05");
      assert.include(window?.label ?? "", "代金券 12.05");
      assert.deepStrictEqual(requests, [
        { url: "https://api.moonshot.cn/v1/users/me/balance", authorization: "Bearer sk-test" },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        stubClient(
          {
            data: {
              available_balance: 59.092506,
              cash_balance: 47.046238,
              voucher_balance: 12.046269,
            },
          },
          requests,
        ),
      ),
    );
  });
});
