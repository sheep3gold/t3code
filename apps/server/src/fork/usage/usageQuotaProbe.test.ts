import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import {
  antigravityProfileDirectory,
  clearUsageQuotaProbeCache,
  readInstanceUsageLimits,
} from "./usageQuotaProbe.ts";

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
      assert.isUndefined(yield* readInstanceUsageLimits(settings, "claude_grok"));
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

  it.live("kimi and kimi_cli probes read the Kimi Code plan windows from the shared home", () => {
    const requests: Array<{ url: string; authorization?: string | undefined }> = [];
    return Effect.gen(function* () {
      clearUsageQuotaProbeCache();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(
        path.join(home, "settings.json"),
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
            ANTHROPIC_AUTH_TOKEN: "sk-kimi",
          },
        }),
      );
      const settings = {
        providerInstances: {
          claude_kimi: { driver: "claudeAgent", config: { homePath: home } },
          kimi_cli: { driver: "acpRegistry" },
        },
      } as never;
      const expectedWindows = [
        {
          id: "limit_5h",
          kind: "session",
          label: "5 小时窗口",
          usedPercent: 25,
          resetsAt: "2026-10-21T05:56:50Z",
        },
        {
          id: "limit_month_total",
          kind: "monthly",
          label: "本月总额度",
          usedPercent: 0.3,
          resetsAt: "2026-11-21T00:56:51Z",
        },
      ] as const;
      for (const instanceKey of ["claude_kimi", "kimi_cli"]) {
        const limits = yield* readInstanceUsageLimits(settings, instanceKey);
        assert.isUndefined(limits?.unavailable);
        assert.deepStrictEqual(limits?.windows, expectedWindows);
      }
      assert.deepStrictEqual(requests, [
        { url: "https://api.kimi.com/coding/v1/usages", authorization: "Bearer sk-kimi" },
        { url: "https://api.kimi.com/coding/v1/usages", authorization: "Bearer sk-kimi" },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        stubClient(
          {
            limits: [
              {
                window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
                detail: { limit: "100", remaining: "75", resetTime: "2026-10-21T05:56:51Z" },
              },
            ],
            usages: {
              limit_5h: { used_ratio: 0.25, reset_time: "2026-10-21T05:56:50Z" },
              limit_month_total: { used_ratio: 0.003, reset_time: "2026-11-21T00:56:51Z" },
            },
          },
          requests,
        ),
      ),
    );
  });

  it.live("deepseek probe reports the CNY prepaid balance with its top-up/granted split", () => {
    const requests: Array<{ url: string; authorization?: string | undefined }> = [];
    return Effect.gen(function* () {
      clearUsageQuotaProbeCache();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(
        path.join(home, "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-ds" } }),
      );
      const settings = {
        providerInstances: {
          claude_deepseek: { driver: "claudeAgent", config: { homePath: home } },
        },
      } as never;
      const limits = yield* readInstanceUsageLimits(settings, "claude_deepseek");
      assert.isUndefined(limits?.unavailable);
      const window = limits?.windows[0];
      assert.strictEqual(window?.id, "balance");
      assert.strictEqual(window?.remaining, 120.37);
      assert.strictEqual(window?.remainingUnit, "元");
      assert.include(window?.label ?? "", "充值 120.37");
      assert.notInclude(window?.label ?? "", "赠送");
      assert.notInclude(window?.label ?? "", "余额不足");
      assert.deepStrictEqual(requests, [
        { url: "https://api.deepseek.com/user/balance", authorization: "Bearer sk-ds" },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        stubClient(
          {
            is_available: true,
            balance_infos: [
              {
                currency: "CNY",
                total_balance: "120.37",
                granted_balance: "0.00",
                topped_up_balance: "120.37",
              },
            ],
          },
          requests,
        ),
      ),
    );
  });

  it.live("deepseek probe flags an unavailable (exhausted) account and shows grants", () => {
    const requests: Array<{ url: string; authorization?: string | undefined }> = [];
    return Effect.gen(function* () {
      clearUsageQuotaProbeCache();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(
        path.join(home, "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-ds" } }),
      );
      const settings = {
        providerInstances: {
          claude_deepseek: { driver: "claudeAgent", config: { homePath: home } },
        },
      } as never;
      const window = (yield* readInstanceUsageLimits(settings, "claude_deepseek"))?.windows[0];
      assert.strictEqual(window?.remaining, 0.5);
      assert.include(window?.label ?? "", "赠送 0.50");
      assert.include(window?.label ?? "", "余额不足");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        stubClient(
          {
            is_available: false,
            balance_infos: [
              {
                currency: "CNY",
                total_balance: "0.50",
                granted_balance: "0.50",
                topped_up_balance: "0.00",
              },
            ],
          },
          requests,
        ),
      ),
    );
  });

  const minimaxInstance = (dataDir: string) =>
    ({ providerInstances: { minimax: { driver: "minimax", config: { dataDir } } } }) as never;
  const minimaxYaml = (key: string) =>
    `defaultModel: x\nminimax_api:\n  apiKey: ${key}\nminimaxModelSource: minimax_api_key\n`;

  it.live("minimax probe maps the 5-hour percent window and an unlimited weekly window", () => {
    const requests: Array<{ url: string; authorization?: string | undefined }> = [];
    return Effect.gen(function* () {
      clearUsageQuotaProbeCache();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dataDir = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(
        path.join(dataDir, "config.yaml"),
        minimaxYaml("sk-cp-test"),
      );
      const limits = yield* readInstanceUsageLimits(minimaxInstance(dataDir), "minimax");
      assert.isUndefined(limits?.unavailable);
      assert.strictEqual(limits?.windows.length, 2);
      const [fiveHour, weekly] = limits?.windows ?? [];
      assert.strictEqual(fiveHour?.id, "five_hour");
      assert.strictEqual(fiveHour?.usedPercent, 1);
      assert.strictEqual(fiveHour?.resetsAt, "2026-10-03T14:40:00.000Z");
      assert.strictEqual(weekly?.id, "weekly");
      assert.strictEqual(weekly?.usedPercent, 0);
      assert.include(weekly?.label ?? "", "无限制");
      assert.isUndefined(weekly?.resetsAt);
      assert.deepStrictEqual(requests, [
        {
          url: "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains",
          authorization: "Bearer sk-cp-test",
        },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        stubClient(
          {
            base_resp: { status_code: 0, status_msg: "success" },
            model_remains: [
              {
                model_name: "general",
                end_time: 1791038400000,
                weekly_end_time: 1791129600000,
                current_interval_status: 1,
                current_interval_remaining_percent: 99,
                current_weekly_status: 3,
                current_weekly_remaining_percent: 100,
              },
              { model_name: "video", current_interval_status: 3 },
            ],
          },
          requests,
        ),
      ),
    );
  });

  it.live("minimax probe degrades to probeFailed when config.yaml holds no key", () =>
    Effect.gen(function* () {
      clearUsageQuotaProbeCache();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dataDir = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(path.join(dataDir, "config.yaml"), "defaultModel: x\n");
      const limits = yield* readInstanceUsageLimits(minimaxInstance(dataDir), "minimax");
      assert.strictEqual(limits?.unavailable?.reason, "probeFailed");
      assert.strictEqual(limits?.windows.length, 0);
    }).pipe(Effect.scoped, Effect.provide(layers)),
  );

  // The legacy→ACP migration renamed the driver to acpRegistry and moved
  // dataDir into the instance environment; the probe must keep up.
  it.live(
    "minimax probe still runs for the migrated acpRegistry instance via MINIMAX_DATA_DIR",
    () => {
      const requests: Array<{ url: string; authorization?: string | undefined }> = [];
      return Effect.gen(function* () {
        clearUsageQuotaProbeCache();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dataDir = yield* fileSystem.makeTempDirectoryScoped();
        yield* fileSystem.writeFileString(
          path.join(dataDir, "config.yaml"),
          minimaxYaml("sk-cp-acp"),
        );
        const settings = {
          providerInstances: {
            minimax: {
              driver: "acpRegistry",
              environment: [{ name: "MINIMAX_DATA_DIR", value: dataDir }],
            },
          },
        } as never;
        const limits = yield* readInstanceUsageLimits(settings, "minimax");
        assert.isUndefined(limits?.unavailable);
        assert.strictEqual(limits?.windows.length, 2);
        assert.deepStrictEqual(requests, [
          {
            url: "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains",
            authorization: "Bearer sk-cp-acp",
          },
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          stubClient(
            {
              base_resp: { status_code: 0, status_msg: "success" },
              model_remains: [
                {
                  model_name: "general",
                  current_interval_status: 3,
                  current_weekly_status: 3,
                },
              ],
            },
            requests,
          ),
        ),
      );
    },
  );

  it.live("factory probe is selected for the migrated acpRegistry instance", () =>
    Effect.gen(function* () {
      clearUsageQuotaProbeCache();
      const settings = {
        providerInstances: { factory: { driver: "acpRegistry" } },
      } as never;
      // No etcd env and no FACTORY_API_KEY: the probe must be selected (not
      // "unsupported") and stop at the missing-key guard. Pointing the etcd
      // env at the real resolver would reach live etcd and the Factory API,
      // so the env-variable path stays covered by the minimax test above.
      const limits = yield* readInstanceUsageLimits(settings, "factory");
      assert.isDefined(limits);
      assert.strictEqual(limits?.unavailable?.reason, "probeFailed");
      assert.include(limits?.unavailable?.message ?? "", "缺少可用的 API key");
    }).pipe(Effect.scoped, Effect.provide(layers)),
  );

  it.live("antigravity probe reads the instance profile under stateDir", () =>
    Effect.gen(function* () {
      clearUsageQuotaProbeCache();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped();
      const settings = {
        providerInstances: { antigravity: { driver: "antigravity" } },
      } as never;

      // Without a state dir the profile cannot be located.
      const unresolved = yield* readInstanceUsageLimits(settings, "antigravity");
      assert.strictEqual(unresolved?.unavailable?.reason, "probeFailed");

      clearUsageQuotaProbeCache();
      const profile = antigravityProfileDirectory(stateDir, "antigravity");
      yield* fileSystem.makeDirectory(path.join(profile, "antigravity-acp"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(profile, "antigravity-acp", "acp_token.json"),
        '{"client_id":"","refresh_token":""}',
      );
      const signedOut = yield* readInstanceUsageLimits(settings, "antigravity", { stateDir });
      assert.strictEqual(signedOut?.unavailable?.reason, "probeFailed");
      assert.include(signedOut?.unavailable?.message ?? "", "未登录");
    }).pipe(Effect.scoped, Effect.provide(layers)),
  );
});
