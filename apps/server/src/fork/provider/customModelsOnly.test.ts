import { describe, expect, it } from "@effect/vitest";
import type { ServerProvider } from "@t3tools/contracts";

import { keepCustomModels, wantsCustomModelsOnly } from "./customModelsOnly.ts";

const model = (slug: string, isCustom: boolean, isDefault?: boolean) => ({
  slug,
  name: slug,
  isCustom,
  ...(isDefault === undefined ? {} : { isDefault }),
  capabilities: null,
});

describe("custom models only", () => {
  it("reads the Claude and Codex flags from the instance environment", () => {
    const flag = (name: string, value: string) => [{ name, value, sensitive: false }];
    expect(wantsCustomModelsOnly(flag("T3_CLAUDE_CUSTOM_MODELS_ONLY", "1"))).toBe(true);
    expect(wantsCustomModelsOnly(flag("T3_CODEX_CUSTOM_MODELS_ONLY", "true"))).toBe(true);
    expect(wantsCustomModelsOnly(flag("T3_CLAUDE_CUSTOM_MODELS_ONLY", "0"))).toBe(false);
    expect(wantsCustomModelsOnly([])).toBe(false);
  });

  it("offers only the configured models, the first as default", () => {
    const snapshot = {
      models: [model("claude-opus-5-5", false, true), model("glm-5.3", true), model("glm-5", true)],
    } as unknown as ServerProvider;
    expect(keepCustomModels(snapshot).models.map((entry) => [entry.slug, entry.isDefault])).toEqual(
      [
        ["glm-5.3", true],
        ["glm-5", false],
      ],
    );
  });

  it("keeps the catalog when no custom model is configured", () => {
    const snapshot = {
      models: [model("claude-opus-5-5", false, true)],
    } as unknown as ServerProvider;
    expect(keepCustomModels(snapshot)).toBe(snapshot);
  });
});
