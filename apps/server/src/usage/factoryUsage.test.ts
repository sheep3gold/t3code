import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { decodeFactorySessionSettings, readFactoryUsage } from "./factoryUsage.ts";

const settingsText = (model: string) =>
  `{"model":"auto","effectiveFactoryRouterModel":{"modelId":"${model}"},` +
  `"tokenUsage":{"inputTokens":100,"outputTokens":40,"cacheCreationTokens":7,` +
  `"cacheReadTokens":900,"thinkingTokens":5,"factoryCredits":1},` +
  `"inclusiveTokenUsage":{"inputTokens":999999}}`;

describe("factoryUsage", () => {
  it("maps the session's own tokenUsage, preferring the routed model", () => {
    assert.deepStrictEqual(decodeFactorySessionSettings(settingsText("claude-opus-5-5")), {
      model: "claude-opus-5-5",
      totals: {
        uncachedInputTokens: 100,
        cachedInputTokens: 900,
        cacheCreationTokens: 7,
        outputTokens: 40,
        reasoningTokens: 5,
      },
    });
    assert.strictEqual(
      decodeFactorySessionSettings('{"model":"gpt-x","tokenUsage":{"inputTokens":1}}')?.model,
      "gpt-x",
    );
    assert.isNull(decodeFactorySessionSettings('{"model":"auto"}'));
    assert.isNull(decodeFactorySessionSettings("not json"));
  });

  it.live("reads settings files under each project directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const project = path.join(root, "-home-user-repo");
      yield* fileSystem.makeDirectory(project, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(project, "s1.settings.json"),
        settingsText("claude-opus-5-5"),
      );
      yield* fileSystem.writeFileString(
        path.join(project, "s1.settings.json.bak"),
        settingsText("ignored"),
      );
      yield* fileSystem.writeFileString(path.join(project, "s1.jsonl"), "{}\n");

      const rows = Option.getOrThrow(yield* readFactoryUsage(root, 0));
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.sessionId, "s1");
      assert.strictEqual(rows[0]?.model, "claude-opus-5-5");

      // Files last written before the window are skipped.
      assert.strictEqual(
        Option.getOrThrow(yield* readFactoryUsage(root, 32_503_680_000_000)).length,
        0,
      );
      assert.isTrue(Option.isNone(yield* readFactoryUsage(path.join(root, "absent"), 0)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
