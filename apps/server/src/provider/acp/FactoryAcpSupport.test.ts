import { describe, expect, it } from "vite-plus/test";
import { FactorySettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  FACTORY_DEFAULT_MODEL_SLUG,
  buildFactoryAcpSpawnInput,
  factoryAuthMethodId,
  factoryAutonomyLevel,
  resolveFactoryAcpModelId,
} from "./FactoryAcpSupport.ts";
const decode = Schema.decodeSync(FactorySettings);
describe("FactoryAcpSupport", () => {
  it("starts droid in ACP mode with the configured binary", () => {
    const settings = decode({ binaryPath: "/opt/droid" });
    expect(buildFactoryAcpSpawnInput(settings, "/workspace", { PATH: "/bin" })).toEqual({
      command: "/opt/droid",
      args: ["exec", "--input-format", "acp", "-o", "acp"],
      cwd: "/workspace",
      env: { PATH: "/bin" },
    });
  });
  it("uses the API key auth method only when a key is present", () => {
    expect(factoryAuthMethodId({ FACTORY_API_KEY: "k" })).toBe("factory-api-key");
    expect(factoryAuthMethodId({ FACTORY_API_KEY: "  " })).toBe("device-pairing");
    expect(factoryAuthMethodId({})).toBe("device-pairing");
  });
  it("maps T3 runtime modes to droid autonomy levels", () => {
    expect(factoryAutonomyLevel("approval-required")).toBe("normal");
    expect(factoryAutonomyLevel("auto-accept-edits")).toBe("auto-low");
    expect(factoryAutonomyLevel("full-access")).toBe("auto-high");
  });
  it("passes droid model ids through verbatim", () => {
    expect(resolveFactoryAcpModelId("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(resolveFactoryAcpModelId("  ")).toBe(FACTORY_DEFAULT_MODEL_SLUG);
    expect(resolveFactoryAcpModelId(undefined)).toBe(FACTORY_DEFAULT_MODEL_SLUG);
  });
});
