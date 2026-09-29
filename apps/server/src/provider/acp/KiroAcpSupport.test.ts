import { describe, expect, it } from "vite-plus/test";

import {
  KIRO_DEFAULT_MODEL_SLUG,
  KIRO_TEXT_GENERATION_MODEL_SLUG,
  kiroAcpSpawnArgs,
  resolveKiroAcpModelId,
} from "./KiroAcpSupport.ts";

describe("resolveKiroAcpModelId", () => {
  it.each([undefined, null, "", "   ", "auto"])(
    "maps an absent or legacy auto selection (%s) to a concrete model",
    (model) => {
      expect(resolveKiroAcpModelId(model)).toBe(KIRO_DEFAULT_MODEL_SLUG);
    },
  );

  it("preserves an available Kiro model id verbatim", () => {
    expect(resolveKiroAcpModelId(" deepseek-3.2 ")).toBe("deepseek-3.2");
  });
});

describe("kiroAcpSpawnArgs", () => {
  it("never passes the removed auto model id to Kiro ACP", () => {
    expect(kiroAcpSpawnArgs(undefined, "full-access", "auto")).toEqual([
      "acp",
      "--agent-engine",
      "v2",
      "--model",
      KIRO_DEFAULT_MODEL_SLUG,
      "--trust-all-tools",
    ]);
  });

  it("uses an available low-cost model for one-shot text generation", () => {
    expect(KIRO_TEXT_GENERATION_MODEL_SLUG).toBe("deepseek-3.2");
  });
});
