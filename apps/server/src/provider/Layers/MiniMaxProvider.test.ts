import { describe, expect, it } from "vite-plus/test";
import { MINIMAX_MODELS } from "./MiniMaxProvider.ts";
describe("MiniMax provider model catalog", () => {
  it("offers every model configured for the native MiniMax account", () => {
    expect(MINIMAX_MODELS).toHaveLength(8);
    expect(new Set(MINIMAX_MODELS.map((model) => model.slug)).size).toBe(8);
    expect(MINIMAX_MODELS.map((model) => model.slug)).toEqual([
      "m:custom_provider%3Aminimax-official-api:MiniMax-M3:v:thinking",
      "m:custom_provider%3Aminimax-official-api:MiniMax-M2.7:v:thinking",
      "m:custom_provider%3Aminimax-official-api:MiniMax-M2.7-highspeed:v:thinking",
      "m:custom_provider%3Aminimax-official-api:MiniMax-M2.5:v:thinking",
      "m:custom_provider%3Aminimax-official-api:MiniMax-M2.5-highspeed:v:thinking",
      "m:custom_provider%3Aminimax-official-api:MiniMax-M2.1:v:thinking",
      "m:custom_provider%3Aminimax-official-api:MiniMax-M2.1-highspeed:v:thinking",
      "m:custom_provider%3Aminimax-official-api:MiniMax-M2:v:thinking",
    ]);
  });
});
