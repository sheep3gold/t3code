import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { applyAcpRegistryModelSelection } from "./adapter.ts";
import { normalizeAcpRegistryLiveConfiguration } from "./probe.ts";

const kimiModels = {
  currentModelId: "kimi-code/k3,thinking",
  availableModels: [
    { modelId: "kimi-code/k3,thinking", name: "k3 (thinking)" },
    { modelId: "kimi-code/kimi-for-coding-highspeed", name: "kimi-for-coding-highspeed" },
  ],
};

const recordingRuntime = (calls: Array<string>) =>
  ({
    setModel: (model: string) => Effect.sync(() => void calls.push(`config:${model}`)),
    setSessionModel: (model: string) =>
      Effect.sync(() => {
        calls.push(`session:${model}`);
        return {};
      }),
  }) as never;

const selecting = (model: string) => ({ instanceId: "kimi_cli", model }) as never;

describe("agents without a model config option", () => {
  it("discover models from the session models state", () => {
    const live = normalizeAcpRegistryLiveConfiguration([], undefined, kimiModels);
    assert.deepStrictEqual(
      live.models.map((model) => model.id),
      ["kimi-code/k3,thinking", "kimi-code/kimi-for-coding-highspeed"],
    );
    assert.strictEqual(live.currentModelId, "kimi-code/k3,thinking");
  });

  it.effect("switch through session/set_model, only to a listed model", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const startResult = { sessionSetupResult: { models: kimiModels } } as never;
      const applied = yield* applyAcpRegistryModelSelection({
        runtime: recordingRuntime(calls),
        startResult,
        modelSelection: selecting("kimi-code/kimi-for-coding-highspeed"),
      });
      const unknown = yield* applyAcpRegistryModelSelection({
        runtime: recordingRuntime(calls),
        startResult,
        modelSelection: selecting("not-listed"),
      });
      assert.strictEqual(applied, "kimi-code/kimi-for-coding-highspeed");
      assert.isUndefined(unknown);
      assert.deepStrictEqual(calls, ["session:kimi-code/kimi-for-coding-highspeed"]);
    }),
  );

  it.effect("agents with a model config option keep using it", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const applied = yield* applyAcpRegistryModelSelection({
        runtime: recordingRuntime(calls),
        startResult: {
          sessionSetupResult: {
            models: kimiModels,
            configOptions: [{ id: "model", category: "model", type: "select" }],
          },
        } as never,
        modelSelection: selecting("kimi-code/kimi-for-coding-highspeed"),
      });
      assert.isUndefined(applied);
      assert.deepStrictEqual(calls, ["config:kimi-code/kimi-for-coding-highspeed"]);
    }),
  );
});
