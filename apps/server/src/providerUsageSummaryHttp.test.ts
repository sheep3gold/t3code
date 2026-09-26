import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageDay,
  type ServerProvider,
  type UsageSummary,
} from "@t3tools/contracts";

import { buildProviderUsageSummary } from "./providerUsageSummaryHttp.ts";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("claude_xjp"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude Pro · XJP",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", email: "must-not-leak@example.test" },
  checkedAt: "2026-09-26T03:00:00.000Z",
  message: "must not leak",
  models: [
    { slug: "opus", name: "Opus", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-09-26T03:00:00.000Z",
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "5 hours",
        usedPercent: 32,
        resetsAt: "2026-09-26T05:00:00.000Z",
      },
    ],
  },
};

const usage: UsageSummary = {
  contractVersion: 5,
  readAt: "2026-09-26T04:00:00.000Z",
  timeZone: "Asia/Shanghai",
  sinceDay: UsageDay.make("2026-08-28"),
  untilDay: UsageDay.make("2026-09-26"),
  buckets: [
    {
      day: UsageDay.make("2026-09-26"),
      provider: "claude",
      model: "opus",
      totals: {
        uncachedInputTokens: 100,
        cachedInputTokens: 20,
        cacheCreationTokens: 10,
        outputTokens: 30,
        reasoningTokens: 15,
      },
      costUsd: 1.25,
      cacheSavingsUsd: 0.1,
      costSource: "modelPriced",
      records: 1,
      unpricedRecords: 0,
      sessions: 1,
    },
  ],
  sources: [],
  pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
  scanDurationMs: 1,
};

describe("provider usage public summary", () => {
  it("keeps only public usage fields and does not double-count reasoning tokens", () => {
    const result = buildProviderUsageSummary([provider], usage);
    expect(result.totals).toEqual({ totalTokens: 160, costUsd: 1.25 });
    expect(result.providers[0]?.usage).toEqual({
      available: true,
      scope: "driver",
      totalTokens: 160,
      costUsd: 1.25,
    });
    expect(result.providers[0]?.usageLimits.windows[0]).toMatchObject({
      id: "five_hour",
      usedPercent: 32,
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain("must-not-leak");
    expect(json).not.toContain("must not leak");
    expect(json).not.toContain("authenticated");
  });

  it("reports unsupported rather than inventing quota or usage for unknown drivers", () => {
    const unknown = {
      ...provider,
      instanceId: ProviderInstanceId.make("kiro"),
      driver: ProviderDriverKind.make("kiro"),
      displayName: "Kiro",
      usageLimits: undefined,
    };
    const result = buildProviderUsageSummary([unknown], { ...usage, buckets: [] });
    expect(result.providers[0]?.usage).toEqual({
      available: false,
      scope: "driver",
      totalTokens: 0,
      costUsd: null,
    });
    expect(result.providers[0]?.usageLimits).toMatchObject({
      windows: [],
      unavailable: { reason: "unsupported" },
    });
  });
});
