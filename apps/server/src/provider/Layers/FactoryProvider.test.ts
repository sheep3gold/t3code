import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_MODEL_BY_PROVIDER, ProviderDriverKind } from "@t3tools/contracts";
import { FACTORY_MODELS } from "./FactoryProvider.ts";
describe("Factory provider model catalog", () => {
  it("lists unique model ids and includes the default", () => {
    const slugs = FACTORY_MODELS.map((model) => model.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toContain(DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make("factory")]);
  });
});
