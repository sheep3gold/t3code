import {
  ProviderDriverKind,
  type ServerProvider,
  type UsageProviderKind,
  type UsageSummary,
  UsageDay,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import * as UsageService from "./usage/UsageService.ts";

const DAY_MS = 86_400_000;
const TIME_ZONE = "Asia/Shanghai";

const usageKindForDriver = (driver: ProviderDriverKind): UsageProviderKind | null => {
  if (driver === "claudeAgent") return "claude";
  if (driver === "codex") return "codex";
  if (driver === "grok") return "grok";
  return null;
};

const bucketTokens = (bucket: UsageSummary["buckets"][number]): number =>
  bucket.totals.uncachedInputTokens +
  bucket.totals.cachedInputTokens +
  bucket.totals.cacheCreationTokens +
  bucket.totals.outputTokens;

export function buildProviderUsageSummary(
  providers: ReadonlyArray<ServerProvider>,
  summary: UsageSummary,
) {
  const byKind = new Map<UsageProviderKind, { totalTokens: number; costUsd: number }>();
  let totalTokens = 0;
  let costUsd = 0;
  for (const bucket of summary.buckets) {
    const tokens = bucketTokens(bucket);
    const current = byKind.get(bucket.provider) ?? { totalTokens: 0, costUsd: 0 };
    current.totalTokens += tokens;
    current.costUsd += bucket.costUsd;
    byKind.set(bucket.provider, current);
    totalTokens += tokens;
    costUsd += bucket.costUsd;
  }

  return {
    contractVersion: 1,
    readAt: summary.readAt,
    sinceDay: summary.sinceDay,
    untilDay: summary.untilDay,
    totals: { totalTokens, costUsd },
    providers: providers.map((provider) => {
      const usageKind = usageKindForDriver(provider.driver);
      const usage = usageKind === null ? null : (byKind.get(usageKind) ?? { totalTokens: 0, costUsd: 0 });
      const limits = provider.usageLimits;
      return {
        id: String(provider.instanceId),
        driver: String(provider.driver),
        displayName: provider.displayName ?? String(provider.instanceId),
        state: provider.status,
        checkedAt: provider.checkedAt,
        modelCount: provider.models.length,
        models: provider.models.map((model) => model.name),
        usage:
          usage === null
            ? { available: false, scope: "driver" as const, totalTokens: 0, costUsd: null }
            : { available: true, scope: "driver" as const, ...usage },
        usageLimits: limits
          ? {
              checkedAt: limits.checkedAt,
              windows: limits.windows.map((window) => ({
                id: window.id,
                kind: window.kind,
                label: window.label,
                usedPercent: window.usedPercent,
                ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
              })),
              ...(limits.unavailable
                ? { unavailable: { reason: limits.unavailable.reason } }
                : {}),
            }
          : {
              checkedAt: provider.checkedAt,
              windows: [],
              unavailable: { reason: "unsupported" as const },
            },
      };
    }),
  };
}

const formatDay = (date: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

export const providerUsageSummaryRouteLayer = HttpRouter.add(
  "GET",
  "/api/provider-usage-summary",
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const usage = yield* UsageService.UsageService;
    const now = new Date();
    const summary = yield* usage.readSummary({
      sinceDay: UsageDay.make(formatDay(new Date(now.getTime() - 29 * DAY_MS))),
      untilDay: UsageDay.make(formatDay(now)),
      timeZone: TIME_ZONE,
      resolution: "day",
    });
    return HttpServerResponse.jsonUnsafe(
      buildProviderUsageSummary(yield* registry.getProviders, summary),
      { headers: { "cache-control": "private, no-store" } },
    );
  }).pipe(
    Effect.catch((cause) =>
      Effect.logError("provider usage summary failed", cause).pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe(
            { error: "provider_usage_unavailable" },
            { status: 503, headers: { "cache-control": "private, no-store" } },
          ),
        ),
      ),
    ),
  ),
);
