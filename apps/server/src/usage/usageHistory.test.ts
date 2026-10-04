import { assert, describe, it } from "@effect/vitest";
import type { UsageBucket } from "@t3tools/contracts";

import { dayInZone, foldDailyUsage, isDay, shiftDay } from "./usageHistory.ts";

const bucket = (
  day: string,
  provider: "claude" | "codex",
  tokens: number,
  costUsd: number,
): UsageBucket => ({
  day: day as UsageBucket["day"],
  provider,
  model: "model-x",
  totals: {
    uncachedInputTokens: tokens,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  },
  costUsd,
  cacheSavingsUsd: 0,
  costSource: "modelPriced",
  records: 1,
  unpricedRecords: 0,
  sessions: 1,
});

describe("usageHistory", () => {
  it("recognizes day strings only in YYYY-MM-DD form", () => {
    assert.isTrue(isDay("2026-10-04"));
    assert.isFalse(isDay("2026-10-4"));
    assert.isFalse(isDay("10/04/2026"));
    assert.isFalse(isDay(""));
  });

  it("shifts days across month and year boundaries", () => {
    assert.equal(shiftDay("2026-10-04" as UsageBucket["day"], -3), "2026-10-01");
    assert.equal(shiftDay("2026-10-01" as UsageBucket["day"], -1), "2026-09-30");
    assert.equal(shiftDay("2025-01-01" as UsageBucket["day"], -1), "2024-12-31");
  });

  it("formats the experienced day in the reporting zone, not UTC", () => {
    // 2026-10-04 17:00 UTC is already 2026-10-05 in Asia/Shanghai.
    assert.equal(dayInZone(Date.UTC(2026, 9, 4, 17), "Asia/Shanghai"), "2026-10-05");
    assert.equal(dayInZone(Date.UTC(2026, 9, 4, 17), "UTC"), "2026-10-04");
    // An unknown zone degrades to UTC instead of throwing.
    assert.equal(dayInZone(Date.UTC(2026, 9, 4, 17), "Mars/Olympus"), "2026-10-04");
  });

  it("folds buckets per day across providers and zero-fills gaps", () => {
    const days = foldDailyUsage(
      [
        bucket("2026-10-01", "claude", 100, 0.5),
        bucket("2026-10-01", "codex", 23.6, 0.25),
        bucket("2026-10-03", "claude", 10, 0.1),
        bucket("2026-10-05", "claude", 7, 0), // Outside the window: dropped.
      ],
      "2026-10-01" as UsageBucket["day"],
      "2026-10-03" as UsageBucket["day"],
    );

    assert.deepStrictEqual(days, [
      { day: "2026-10-01", totalTokens: 124, costUsd: 0.75 },
      { day: "2026-10-02", totalTokens: 0, costUsd: 0 },
      { day: "2026-10-03", totalTokens: 10, costUsd: 0.1 },
    ]);
  });

  it("returns an empty fold for an inverted window", () => {
    assert.deepStrictEqual(
      foldDailyUsage([], "2026-10-03" as UsageBucket["day"], "2026-10-01" as UsageBucket["day"]),
      [],
    );
  });
});
