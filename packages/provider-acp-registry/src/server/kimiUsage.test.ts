import { describe, expect, it } from "vitest";

import { isKimiCliCommand, kimiUsageFormat, parseKimiLine } from "./kimiUsage.ts";

describe("Kimi CLI transcript usage", () => {
  const status = {
    timestamp: 1792650000.125,
    message: {
      type: "StatusUpdate",
      payload: {
        message_id: "response-1",
        token_usage: {
          input_other: 518,
          input_cache_read: 54016,
          input_cache_creation: 4,
          output: 157,
        },
      },
    },
  };

  it("attributes per-response token buckets from wire status updates", () => {
    const record = parseKimiLine(JSON.stringify(status));
    expect(record).toMatchObject({
      provider: "kimi",
      model: "kimi-code",
      timestampMs: 1792650000125,
      dedupeKey: "kimi:response-1",
      totals: {
        uncachedInputTokens: 518,
        cachedInputTokens: 54016,
        cacheCreationTokens: 4,
        outputTokens: 157,
        reasoningTokens: 0,
      },
    });
    expect(kimiUsageFormat.parseProjected?.(status)).toEqual([record]);
  });

  it("ignores unrelated events, malformed JSON, and empty usage", () => {
    expect(parseKimiLine("not json")).toBeNull();
    expect(
      parseKimiLine(JSON.stringify({ ...status, message: { type: "Text", payload: {} } })),
    ).toBeNull();
    expect(
      parseKimiLine(
        JSON.stringify({
          ...status,
          message: { type: "StatusUpdate", payload: { token_usage: { output: 0 } } },
        }),
      ),
    ).toBeNull();
  });

  it("selects only native Kimi CLI commands", () => {
    expect(isKimiCliCommand("/home/ubuntu/.local/bin/kimi")).toBe(true);
    expect(isKimiCliCommand("C:\\tools\\kimi-cli.exe")).toBe(true);
    expect(isKimiCliCommand("/usr/bin/other-acp")).toBe(false);
  });
});
