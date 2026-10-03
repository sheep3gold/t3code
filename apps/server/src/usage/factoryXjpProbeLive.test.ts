import { assert, describe, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import { readInstanceUsageLimits } from "./usageQuotaProbe.ts";

const layers = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

describe.skipIf(process.env.T3_FACTORY_ETCD_KEY === undefined)("factory usage probe", () => {
  it.live("reads the allowance through the xjp proxy", () =>
    Effect.gen(function* () {
      const settings = {
        providerInstances: {
          factory: {
            driver: "factory",
            config: { apiKeyEtcdKey: process.env.T3_FACTORY_ETCD_KEY },
          },
        },
      } as never;
      const limits = yield* readInstanceUsageLimits(settings, "factory");
      assert.isDefined(limits);
      assert.strictEqual(limits.unavailable, undefined);
      assert.isAtLeast(limits.windows.length, 1);
    }).pipe(Effect.provide(layers)),
  );
});
