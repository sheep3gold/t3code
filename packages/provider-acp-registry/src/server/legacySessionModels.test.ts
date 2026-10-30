import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { applyAcpRegistryModelSelection } from "./adapter.ts";
import { applyAcpRegistryLiveConfiguration } from "./driver.ts";
import { normalizeAcpRegistryLiveConfiguration } from "./probe.ts";

const kimiModels = {
  currentModelId: "kimi-code/k3,thinking",
  availableModels: [
    { modelId: "kimi-code/k3,thinking", name: "k3 (thinking)" },
    { modelId: "kimi-code/kimi-for-coding-highspeed", name: "kimi-for-coding-highspeed" },
  ],
};

const recordingRuntime = (calls: Array<string>, configOptions: ReadonlyArray<unknown> = []) =>
  ({
    getConfigOptions: Effect.succeed(configOptions),
    setModel: (model: string) => Effect.sync(() => void calls.push(`config:${model}`)),
    setSessionModel: (model: string) =>
      Effect.sync(() => {
        calls.push(`session:${model}`);
        return {};
      }),
  }) as never;

const selecting = (model: string, options?: ReadonlyArray<{ id: string; value: boolean }>) =>
  ({ instanceId: "kimi_cli", model, ...(options === undefined ? {} : { options }) }) as never;

describe("agents without a model config option", () => {
  it("discover models from the session models state", () => {
    const live = normalizeAcpRegistryLiveConfiguration([], undefined, kimiModels);
    assert.deepStrictEqual(
      live.models.map((model) => model.id),
      ["kimi-code/k3,thinking", "kimi-code/kimi-for-coding-highspeed"],
    );
    assert.strictEqual(live.currentModelId, "kimi-code/k3,thinking");
  });

  it.effect("leave plain models to the default ACP model selection", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const startResult = { sessionSetupResult: { models: kimiModels } } as never;
      const applied = yield* applyAcpRegistryModelSelection({
        runtime: recordingRuntime(calls),
        startResult,
        modelSelection: selecting("kimi-code/kimi-for-coding-highspeed"),
      });
      assert.isNull(applied);
      assert.deepStrictEqual(calls, []);
    }),
  );

  it.effect("agents with a model config option keep the default protocol", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const applied = yield* applyAcpRegistryModelSelection({
        runtime: recordingRuntime(calls, [{ id: "model", category: "model", type: "select" }]),
        startResult: { sessionSetupResult: { models: kimiModels } } as never,
        modelSelection: selecting("kimi-code/kimi-for-coding-highspeed"),
      });
      assert.isNull(applied);
      assert.deepStrictEqual(calls, []);
    }),
  );
});

const variantModels = {
  currentModelId: "kimi-code/k3",
  availableModels: [
    { modelId: "kimi-code/k3", name: "k3" },
    { modelId: "kimi-code/k3,thinking", name: "k3 (thinking)" },
    { modelId: "kimi-code/k3.1-pro", name: "k3.1-pro" },
    { modelId: "kimi-code/k3.1-pro,thinking", name: "k3.1-pro (thinking)" },
    { modelId: "kimi-code/k2-thinker,thinking", name: "k2-thinker (thinking)" },
  ],
};

describe("thinking model variants", () => {
  it("collapse into one model with a Thinking toggle", () => {
    const live = normalizeAcpRegistryLiveConfiguration([], undefined, variantModels);
    const provider = applyAcpRegistryLiveConfiguration(
      { models: [], enabled: true, status: "ready" } as never,
      live,
      [],
    );
    assert.deepStrictEqual(
      provider.models.map((model) => [
        model.slug,
        model.name,
        model.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id) ?? [],
      ]),
      [
        ["kimi-code/k3", "k3", ["_t3/thinking"]],
        // Kimi's API rejects K3.1 Pro without thinking, so there is nothing to toggle.
        ["kimi-code/k3.1-pro", "k3.1-pro", []],
        ["kimi-code/k2-thinker", "k2-thinker", []],
      ],
    );
    assert.isTrue(provider.models[0]?.isDefault);
  });

  it.effect("open the thinking variant unless the toggle is off", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const startResult = { sessionSetupResult: { models: variantModels } } as never;
      const open = (model: string, options?: ReadonlyArray<{ id: string; value: boolean }>) =>
        applyAcpRegistryModelSelection({
          runtime: recordingRuntime(calls),
          startResult,
          modelSelection: selecting(model, options),
        });
      const off = [{ id: "_t3/thinking", value: false }];
      yield* open("kimi-code/k3");
      yield* open("kimi-code/k3", off);
      yield* open("kimi-code/k3.1-pro", off);
      yield* open("kimi-code/k2-thinker", off);
      yield* open("kimi-code/k3,thinking", off);
      // A plain or already-variant model is left to the default protocol.
      assert.deepStrictEqual(calls, [
        "session:kimi-code/k3,thinking",
        "session:kimi-code/k3.1-pro,thinking",
        "session:kimi-code/k2-thinker,thinking",
      ]);
    }),
  );
});
