// @effect-diagnostics processEnvInEffect:off -- fork code predates these upstream style rules.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
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

/** HttpClient answering each request with the first route whose URL prefix
 * matches, recording the URLs hit. */
const stubClientByRoute = (
  routes: ReadonlyArray<{
    readonly prefix: string;
    readonly body: unknown;
    readonly status?: number;
  }>,
  requests: Array<{ url: string; authorization?: string | undefined; body?: unknown }>,
) =>
  Layer.merge(
    NodeServices.layer,
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push({
          url: request.url,
          authorization: request.headers.authorization,
          body: request.body,
        });
        const route = routes.find((candidate) => request.url.startsWith(candidate.prefix));
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(route?.body ?? {}), {
              status: route?.status ?? (route === undefined ? 404 : 200),
            }),
          ),
        );
      }),
    ),
  );

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

  it.live(
    "kimi_cli reads native token without a claude_kimi instance, then falls back when expired",
    () => {
      const requests: Array<{ url: string; authorization?: string | undefined }> = [];
      return Effect.gen(function* () {
        clearUsageQuotaProbeCache();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectoryScoped();
        const credentialDir = path.join(home, ".kimi", "credentials");
        yield* fileSystem.makeDirectory(credentialDir, { recursive: true });
        const settings = { providerInstances: { kimi_cli: { driver: "acpRegistry" } } } as never;
        const originalHome = process.env.HOME;
        process.env.HOME = home;
        try {
          const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
          yield* fileSystem.writeFileString(
            path.join(credentialDir, "kimi-code.json"),
            JSON.stringify({ access_token: "native-key", expires_at: nowMs / 1000 + 900 }),
          );
          const native = yield* readInstanceUsageLimits(settings, "kimi_cli");
          assert.deepStrictEqual(
            native?.windows.map((window) => window.usedPercent),
            [25],
          );
          assert.deepStrictEqual(requests, [
            { url: "https://api.kimi.com/coding/v1/usages", authorization: "Bearer native-key" },
          ]);

          clearUsageQuotaProbeCache();
          yield* fileSystem.writeFileString(
            path.join(credentialDir, "kimi-code.json"),
            JSON.stringify({ access_token: "expired-key", expires_at: 1 }),
          );
          const fallbackHome = path.join(home, ".claude-kimi");
          yield* fileSystem.makeDirectory(fallbackHome);
          yield* fileSystem.writeFileString(
            path.join(fallbackHome, "settings.json"),
            JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "stable-key" } }),
          );
          const fallback = yield* readInstanceUsageLimits(settings, "kimi_cli");
          assert.deepStrictEqual(
            fallback?.windows.map((window) => window.usedPercent),
            [25],
          );
          assert.deepStrictEqual(requests[1], {
            url: "https://api.kimi.com/coding/v1/usages",
            authorization: "Bearer stable-key",
          });
        } finally {
          if (originalHome === undefined) delete process.env.HOME;
          else process.env.HOME = originalHome;
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(stubClient({ usages: { limit_5h: { used_ratio: 0.25 } } }, requests)),
      );
    },
  );

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
      const previousKey = process.env.FACTORY_API_KEY;
      delete process.env.FACTORY_API_KEY;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousKey !== undefined) process.env.FACTORY_API_KEY = previousKey;
        }),
      );
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

  it.live("kiro probe is selected for acpRegistry instance with commandPath", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const previousHome = process.env.HOME;
      process.env.HOME = yield* fileSystem.makeTempDirectoryScoped();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousHome === undefined) {
            delete process.env.HOME;
          } else {
            process.env.HOME = previousHome;
          }
        }),
      );
      clearUsageQuotaProbeCache();
      const settings = {
        providerInstances: {
          kiro: {
            driver: "acpRegistry",
            config: { commandPath: "/usr/bin/kiro-cli" },
          },
        },
      } as never;

      // Probe is selected (not "unsupported"), but without kiro-cli DB it fails.
      const limits = yield* readInstanceUsageLimits(settings, "kiro");
      assert.isDefined(limits);
      assert.strictEqual(limits?.unavailable?.reason, "probeFailed");
      assert.include(limits?.unavailable?.message ?? "", "未登录");
    }).pipe(Effect.scoped, Effect.provide(layers)),
  );

  // The glmuse dashboard indexes keys by their 28-char prefix; the probe must
  // send exactly that and never the full key.
  const glmCodingKey = "a".repeat(24) + "." + "b".repeat(24);
  const requestBodyText = (body: unknown): string => {
    if (typeof body === "string") return body;
    if (body instanceof Uint8Array) return new TextDecoder().decode(body);
    const inner = (body as { body?: unknown } | null | undefined)?.body;
    if (inner instanceof Uint8Array) return new TextDecoder().decode(inner);
    return body === undefined || body === null ? "" : JSON.stringify(body);
  };
  const glmCodingHome = (fileSystem: FileSystem.FileSystem, path: Path.Path) =>
    Effect.gen(function* () {
      const home = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(
        path.join(home, "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: glmCodingKey } }),
      );
      return home;
    });
  const glmCodingSettings = (home: string) =>
    ({
      providerInstances: {
        claude_glm_coding: { driver: "claudeAgent", config: { homePath: home } },
      },
    }) as never;

  it.live("glm_coding probe merges Zhipu lanes with the glmuse plan window", () => {
    const requests: Array<{ url: string; authorization?: string | undefined; body?: unknown }> = [];
    return Effect.gen(function* () {
      clearUsageQuotaProbeCache();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* glmCodingHome(fileSystem, path);
      const limits = yield* readInstanceUsageLimits(glmCodingSettings(home), "claude_glm_coding");
      assert.isUndefined(limits?.unavailable);
      assert.strictEqual(limits?.windows.length, 3);
      const [fiveHour, weekly, plan] = limits?.windows ?? [];
      assert.strictEqual(fiveHour?.id, "five_hour");
      assert.strictEqual(fiveHour?.usedPercent, 9);
      assert.strictEqual(
        fiveHour?.resetsAt,
        DateTime.formatIso(DateTime.makeUnsafe(1794382349557)),
      );
      assert.strictEqual(weekly?.id, "weekly_tokens");
      assert.strictEqual(weekly?.usedPercent, 1);
      assert.strictEqual(plan?.id, "plan_allowance");
      assert.strictEqual(plan?.usedPercent, 2.5);
      assert.strictEqual(plan?.remaining, 974523495);
      assert.strictEqual(plan?.remainingUnit, "tokens");
      assert.include(plan?.label ?? "", "12月10日");

      const bodyText = requests.map((request) => requestBodyText(request.body)).join("\n");
      assert.notInclude(bodyText, "b".repeat(21));
      assert.include(bodyText, glmCodingKey.slice(0, 28));
      assert.deepStrictEqual(
        requests.map((request) => request.url),
        [
          "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
          "http://glmuse.mlik.top/api/usage-by-key",
        ],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        stubClientByRoute(
          [
            {
              prefix: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
              body: {
                code: 200,
                msg: "操作成功",
                data: {
                  limits: [
                    {
                      type: "TOKENS_LIMIT",
                      unit: 3,
                      number: 5,
                      percentage: 9,
                      nextResetTime: 1794382349557,
                    },
                    {
                      type: "TOKENS_LIMIT",
                      unit: 6,
                      number: 1,
                      percentage: 1,
                      nextResetTime: 1794964259983,
                    },
                  ],
                  level: "max",
                },
                success: true,
              },
            },
            {
              prefix: "http://glmuse.mlik.top/api/usage-by-key",
              body: {
                success: true,
                data: {
                  usageLimit: 1000000000,
                  usageCount: 25906273,
                  remaining: 974523495,
                  expireAt: "2026-12-10T15:59:59.999Z",
                },
              },
            },
          ],
          requests,
        ),
      ),
    );
  });

  it.live("glm_coding probe keeps the lanes when the plan dashboard fails", () => {
    const requests: Array<{ url: string; authorization?: string | undefined; body?: unknown }> = [];
    return Effect.gen(function* () {
      clearUsageQuotaProbeCache();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* glmCodingHome(fileSystem, path);
      const limits = yield* readInstanceUsageLimits(glmCodingSettings(home), "claude_glm_coding");
      assert.isUndefined(limits?.unavailable);
      assert.deepStrictEqual(
        limits?.windows.map((window) => window.id),
        ["five_hour"],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        stubClientByRoute(
          [
            {
              prefix: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
              body: { data: { limits: [{ unit: 3, number: 5, percentage: 40 }] } },
            },
            { prefix: "http://glmuse.mlik.top/api/usage-by-key", body: {}, status: 500 },
          ],
          requests,
        ),
      ),
    );
  });

  it.live("glm_coding probe degrades to probeFailed when both upstreams fail", () => {
    const requests: Array<{ url: string; authorization?: string | undefined; body?: unknown }> = [];
    return Effect.gen(function* () {
      clearUsageQuotaProbeCache();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* glmCodingHome(fileSystem, path);
      const limits = yield* readInstanceUsageLimits(glmCodingSettings(home), "claude_glm_coding");
      assert.strictEqual(limits?.unavailable?.reason, "probeFailed");
      assert.strictEqual(limits?.windows.length, 0);
      assert.include(limits?.unavailable?.message ?? "", "官方额度接口");
      assert.include(limits?.unavailable?.message ?? "", "用量面板");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        stubClientByRoute(
          [
            {
              prefix: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
              body: {},
              status: 500,
            },
            { prefix: "http://glmuse.mlik.top/api/usage-by-key", body: {}, status: 500 },
          ],
          requests,
        ),
      ),
    );
  });
});
