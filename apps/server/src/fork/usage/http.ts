/**
 * `/api/provider-usage-summary` on the upstream base.
 *
 * Upstream's usage page reads `UsageService.readSummary` over a websocket; the
 * fork's own hub pages (the model-usage page and the zxytech mini program) poll
 * this HTTP route instead, and use the fork-only quota probes to show balance
 * windows the upstream service never reads. It is registered as a raw
 * `HttpRouter` route, like upstream's asset and OTLP routes, because it serves
 * an untyped JSON document rather than an `EnvironmentHttpApi` group.
 *
 * @module fork/usage/http
 */
import { AuthOrchestrationReadScope, UsageReadError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../../config.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as UsageLimitSources from "../../usage/UsageLimitSources.ts";
import * as UsageService from "../../usage/UsageService.ts";
import { readInstanceUsageLimits } from "./usageQuotaProbe.ts";
import { dayInZone, foldDailyUsage, isDay, shiftDay } from "./usageHistory.ts";

const PROVIDER_USAGE_SUMMARY_PATH = "/api/provider-usage-summary";

/** Longest trailing window the daily history fold serves. */
const PROVIDER_USAGE_HISTORY_MAX_DAYS = 90;

/** Days bucket into this zone so a turn lands on the day the user experienced. */
const PROVIDER_USAGE_HISTORY_TIME_ZONE = "Asia/Shanghai";

export const layerProviderUsageSummaryRoute = HttpRouter.add(
  "GET",
  PROVIDER_USAGE_SUMMARY_PATH,
  Effect.gen(function* () {
    // The payload is the sanitized summary other zxytech hubs proxy
    // server-to-server behind an nginx IP allowlist (101 web-hub), so a
    // request without credentials is allowed through; when credentials are
    // present they must carry the orchestration read scope. Invalid
    // credentials still fail rather than silently downgrading to anonymous.
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(
        (error): error is EnvironmentAuth.ServerAuthMissingCredentialError =>
          EnvironmentAuth.isServerAuthCredentialError(error) &&
          EnvironmentAuth.serverAuthCredentialReason(error) === "missing_credential",
        () => Effect.succeed(null),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(
          EnvironmentAuth.serverAuthCredentialReason(error),
          EnvironmentAuth.serverAuthDpopFailureReason(error),
        ),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (session !== null && !session.scopes.includes(AuthOrchestrationReadScope)) {
      return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
    }
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    const usageLimitSources = yield* UsageLimitSources.UsageLimitSources;
    const usageService = yield* UsageService.UsageService;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const providers = yield* providerRegistry.getProviders;
    const usageLimitSourceSnapshots = yield* usageLimitSources.current;
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const { stateDir } = yield* ServerConfig.ServerConfig;

    // Lazy-loading modes for the model-usage page and the mini program:
    // `scope=index` answers with identities only (no scans, no probes) so the
    // client can paint cards at once; `instance=<id>` computes just that card,
    // and `refresh=1` additionally skips the quota-probe cache.
    const requestUrl = HttpServerRequest.toURL(request);
    const params = Option.isSome(requestUrl)
      ? requestUrl.value.searchParams
      : new URLSearchParams();
    const scope = params.get("scope");
    const instanceParam = params.get("instance");
    const refresh = params.get("refresh") === "1";
    const accountEntries = usageLimitSourceSnapshots.flatMap((source) =>
      source.accounts.map((account) => ({
        id: `${source.id}:${account.id}`,
        driver: account.driver,
        displayName: account.plan ?? source.label,
        modelCount: 0,
        state: "ready" as const,
        usageLimits: account.usageLimits,
      })),
    );
    const providerIdentity = (provider: (typeof providers)[number]) => ({
      id: provider.instanceId,
      driver: provider.driver,
      displayName: provider.displayName ?? provider.driver,
      modelCount: provider.models.length,
      state: provider.status,
    });

    if (scope === "index") {
      return HttpServerResponse.jsonUnsafe({
        providers: [
          ...providers.map(providerIdentity),
          ...accountEntries.map((entry) => ({
            id: entry.id,
            driver: entry.driver,
            displayName: entry.displayName,
            modelCount: entry.modelCount,
            state: entry.state,
          })),
        ],
        readAt: DateTime.formatIso(yield* DateTime.now),
      });
    }

    if (scope === "history") {
      // Daily rows for the model-usage page's chart: one entry per calendar
      // day, zero-filled, folded from the same transcript scan the usage page
      // reads. Unlike the quota probes this is a local, warm-cached scan, so
      // the page may poll it without hammering any upstream.
      const daysParam = Number.parseInt(params.get("days") ?? "", 10);
      const days = Number.isFinite(daysParam)
        ? Math.min(PROVIDER_USAGE_HISTORY_MAX_DAYS, Math.max(1, daysParam))
        : PROVIDER_USAGE_HISTORY_MAX_DAYS;
      const untilParam = params.get("untilDay");
      if (untilParam !== null && !isDay(untilParam)) {
        return HttpServerResponse.jsonUnsafe({ error: "invalid untilDay" }, { status: 400 });
      }
      // `untilDay` defaults to today in the reporting zone; an explicit value
      // is the caller's own window (a future day simply yields zero rows).
      const untilDay =
        untilParam ??
        dayInZone(DateTime.toEpochMillis(yield* DateTime.now), PROVIDER_USAGE_HISTORY_TIME_ZONE);
      const sinceDay = shiftDay(untilDay, -(days - 1));
      const scanned = yield* usageService
        .readSummary({
          sinceDay,
          untilDay,
          timeZone: PROVIDER_USAGE_HISTORY_TIME_ZONE,
          resolution: "day",
        })
        .pipe(
          Effect.catch((error: UsageReadError) =>
            Effect.logWarning("Provider usage history scan failed", { detail: error.detail }).pipe(
              Effect.as(null),
            ),
          ),
        );
      return HttpServerResponse.jsonUnsafe({
        timeZone: PROVIDER_USAGE_HISTORY_TIME_ZONE,
        sinceDay,
        untilDay,
        days: foldDailyUsage(scanned?.buckets ?? [], sinceDay, untilDay),
        available: scanned !== null,
        readAt: scanned?.readAt ?? DateTime.formatIso(yield* DateTime.now),
      });
    }

    const readAtNow = DateTime.formatIso(yield* DateTime.now);

    if (instanceParam !== null) {
      const provider = providers.find((candidate) => candidate.instanceId === instanceParam);
      const account = accountEntries.find((entry) => entry.id === instanceParam);
      if (provider === undefined && account === undefined) {
        return HttpServerResponse.jsonUnsafe({ error: "unknown instance" }, { status: 404 });
      }
      if (provider === undefined || account !== undefined) {
        // A limit-source account carries its windows already and has no
        // transcript home to attribute usage to.
        return HttpServerResponse.jsonUnsafe({
          provider: { ...account, usage: { available: false } },
          readAt: readAtNow,
        });
      }
      const limits =
        settings === null
          ? undefined
          : yield* readInstanceUsageLimits(settings, provider.instanceId, {
              refresh,
              stateDir,
            }).pipe(Effect.orElseSucceed(() => undefined));
      return HttpServerResponse.jsonUnsafe({
        provider: {
          ...providerIdentity(provider),
          usage: { available: false },
          usageLimits: limits ??
            provider.usageLimits ?? {
              checkedAt: readAtNow,
              windows: [],
              unavailable: { reason: "unsupported" },
            },
        },
        readAt: readAtNow,
      });
    }

    // Every card at once, for clients that render the whole page in one shot.
    // Upstream's `UsageService` has no per-instance attribution method, so the
    // summary here is the transcript scan alone; probes still fill the windows.
    const instanceLimits = yield* Effect.forEach(
      providers,
      (provider) =>
        settings === null
          ? Effect.succeed([provider.instanceId, undefined] as const)
          : readInstanceUsageLimits(settings, provider.instanceId, { refresh, stateDir }).pipe(
              Effect.map((limits) => [provider.instanceId, limits] as const),
              Effect.orElseSucceed(() => [provider.instanceId, undefined] as const),
            ),
      // Anthropic's OAuth usage endpoint rate-limits aggressively; serial
      // probes plus the probe cache keep bursts of page refreshes from
      // tripping it.
      { concurrency: 1 },
    );
    const limitsById = new Map(instanceLimits);

    return HttpServerResponse.jsonUnsafe({
      providers: [
        ...providers.map((provider) => ({
          id: provider.instanceId,
          driver: provider.driver,
          displayName: provider.displayName ?? provider.driver,
          modelCount: provider.models.length,
          state: provider.status,
          usage: { available: false },
          usageLimits: limitsById.get(provider.instanceId) ??
            provider.usageLimits ?? {
              checkedAt: readAtNow,
              windows: [],
              unavailable: { reason: "unsupported" },
            },
        })),
        ...accountEntries.map((entry) => ({
          id: entry.id,
          driver: entry.driver,
          displayName: entry.displayName,
          modelCount: entry.modelCount,
          state: entry.state,
          usage: { available: false },
          usageLimits: entry.usageLimits,
        })),
      ],
      readAt: readAtNow,
    });
  }),
);

export const layer = Layer.mergeAll(layerProviderUsageSummaryRoute);
