import { describe, expect, it } from "vite-plus/test";
import { MiniMaxSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  MINIMAX_DEFAULT_MODEL_SLUG,
  buildMiniMaxAcpSpawnInput,
  miniMaxExecModel,
  miniMaxPermissionMode,
  miniMaxProcessEnvironment,
  resolveMiniMaxAcpModelId,
} from "./MiniMaxAcpSupport.ts";
const decode = Schema.decodeSync(MiniMaxSettings);
describe("MiniMaxAcpSupport", () => {
  it("starts the native mcode ACP server with an isolated data directory", () => {
    const settings = decode({ binaryPath: "/opt/mcode", dataDir: "/srv/minimax" });
    expect(buildMiniMaxAcpSpawnInput(settings, "/workspace", { PATH: "/bin" })).toEqual({
      command: "/opt/mcode",
      args: ["acp"],
      cwd: "/workspace",
      env: { PATH: "/bin", MINIMAX_DATA_DIR: "/srv/minimax" },
    });
  });
  it("does not invent a data directory when none is configured", () => {
    expect(miniMaxProcessEnvironment(decode({}), { PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });
  it("maps T3 permission modes to MiniMax ACP values", () => {
    expect(miniMaxPermissionMode("approval-required")).toBe("default");
    expect(miniMaxPermissionMode("full-access")).toBe("bypassPermissions");
    expect(miniMaxPermissionMode("auto-accept-edits")).toBe("auto");
  });
  it("preserves ACP model option ids and converts them for mcode exec", () => {
    const model = "m:custom_provider%3Aminimax-official-api:MiniMax-M2.7:v:thinking";
    expect(resolveMiniMaxAcpModelId(model)).toBe(model);
    expect(miniMaxExecModel(model)).toBe("custom_provider:minimax-official-api/MiniMax-M2.7");
    expect(resolveMiniMaxAcpModelId(undefined)).toBe(MINIMAX_DEFAULT_MODEL_SLUG);
  });
});
