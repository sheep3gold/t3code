import { assert, it } from "@effect/vitest";

import { selectVisibleClaudeModels } from "./ClaudeProvider.ts";

const builtIns = [
  { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
];
const customModels = [{ slug: "grok-4.7", name: "Grok 4.7" }, "grok-4.5"];

it("keeps built-in Claude models ahead of custom models by default", () => {
  const models = selectVisibleClaudeModels(builtIns, customModels, {});

  assert.deepStrictEqual(
    models.map((model) => model.slug),
    ["claude-opus-5-5", "grok-4.7", "grok-4.5"],
  );
});

it("shows only configured custom models when T3_CLAUDE_CUSTOM_MODELS_ONLY is set", () => {
  const models = selectVisibleClaudeModels(builtIns, customModels, {
    T3_CLAUDE_CUSTOM_MODELS_ONLY: "1",
  });

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "grok-4.7", isDefault: true },
      { slug: "grok-4.5", isDefault: undefined },
    ],
  );
});
