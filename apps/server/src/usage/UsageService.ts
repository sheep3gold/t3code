import * as NodeOS from "node:os";

import {
  type ProviderInstanceConfig,
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
  type ServerSettings as ServerSettingsValue,
  type UsageProviderKind,
  type UsageSource,
  type UsagePricing,
  type UsageSummary,
  type UsageSummaryInput,
  type UsageInstancesSummary,
  UsageReadError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientResponse } from "effect/http";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { BUILT_IN_USAGE_DRIVERS, type BuiltInUsageReadersEnv } from "../provider/builtInDrivers.ts";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type {
  ProviderUsageInstance,
  TranscriptUsageFormat,
  UsageRecord,
} from "@t3tools/provider-core/server/usage";
import { totalTokens } from "@t3tools/provider-core/server/usage";
import { resolveModelAliases, UsageAggregator } from "./usageAggregation.ts";
import {
  createOverrideRateTable,
  parseRateTable,
  priceUsage,
  type RateTable,
} from "./usagePricing.ts";
import {
  listTranscriptFiles,
  readDirectoryVolumeId,
  readTranscriptRecords,
} from "./usageTranscriptReader.ts";
import {
  decodeScanCache,
  dedupeWithinFile,
  LEGACY_SCAN_CACHE_FILE_NAME,
  makeScanCacheWriter,
  pruneScanCache,
  SCAN_CACHE_FILE_NAME,
  type CachedFile,
  type ScanCache,
} from "./usageScanCache.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const LITELLM_RATES_API_URL =
  "https://api.github.com/repos/BerriAI/litellm/contents/model_prices_and_context_window.json?ref=main";

const RATES_TTL_MS = 24 * 60 * 60 * 1000;

const RATES_REFRESH_FLOOR_MS = 60 * 1000;

/**
 * Files are filtered by mtime before opening. The slack covers a session whose
 * last write lands just before local midnight on the window's first day.
 */
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const MAX_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;

const CACHE_RETENTION_DAYS = 92;

const TRANSCRIPT_READ_CONCURRENCY = 4;

const driverReaders = BUILT_IN_USAGE_DRIVERS.flatMap((driver) => {
  const usage = driver.usage;
  const readers = usage === undefined ? [] : "kind" in usage ? [usage] : usage;
  return readers.map((reader) => ({ driver, reader }));
});

const transcriptReaders = driverReaders.flatMap(({ driver, reader }) =>
  reader.kind === "transcripts" ? [{ driver, reader }] : [],
);

const scanReaders = driverReaders.flatMap(({ driver, reader }) =>
  reader.kind === "scan" ? [{ driver, reader }] : [],
);

const transcriptFormats = new Map(
  transcriptReaders.map(({ reader }) => [reader.provider, reader.format] as const),
);

interface TranscriptSource {
  readonly provider: UsageProviderKind;
  readonly format: TranscriptUsageFormat<unknown>;
  readonly dir: string;
  readonly volumeId: string;
  readonly fileName?: string;
}

const RatesCacheFile = Schema.Struct({
  fetchedAtMs: Schema.Number,
  document: Schema.Unknown,
});
const decodeRatesCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);
const encodeRatesCache = Schema.encodeEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);

const ScanCacheJson = Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>);
const decodeScanCacheFile = Schema.decodeUnknownEffect(ScanCacheJson);
const encodeUsageRecordKey = Schema.encodeSync(ScanCacheJson);
const CachedSource = Schema.Struct({ dir: Schema.String, volumeId: Schema.String });

function isLaterRead(a: CachedFile, b: CachedFile): boolean {
  return a.mtimeMs > b.mtimeMs || (a.mtimeMs === b.mtimeMs && a.size > b.size);
}

const sharedSessionProviders: ReadonlySet<UsageProviderKind> = new Set(
  transcriptReaders.flatMap(({ reader }) =>
    reader.format.sharedSessionsAcrossFiles ? [reader.provider] : [],
  ),
);

/**
 * Only these need cross-file dedupe keys: within one file the occurrence count
 * already keeps every key unique, so keying the rest would only build and hash
 * a string for each of their records.
 */
function sharedSessions(
  files: readonly { readonly records: readonly UsageRecord[] }[],
): ReadonlySet<string> {
  const firstFile = new Map<string, number>();
  const shared = new Set<string>();
  for (const [index, file] of files.entries()) {
    let previous = "";
    for (const { provider, sessionId } of file.records) {
      if (!sharedSessionProviders.has(provider) || sessionId === previous || sessionId.length === 0)
        continue;
      previous = sessionId;
      const first = firstFile.get(sessionId);
      if (first === undefined) firstFile.set(sessionId, index);
      else if (first !== index) shared.add(sessionId);
    }
  }
  return shared;
}
const decodeCachedSources = Schema.decodeUnknownOption(
  Schema.Struct({ sources: Schema.Record(Schema.String, CachedSource) }),
);

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
    /**
     * Scans the trailing `days` of transcripts and attributes usage to the
     * configured provider instances rather than physical transcript volumes.
     * Two instances of one driver (e.g. two codex homes serving overlapping
     * model slugs) must never merge, so attribution goes by instance home
     * directory. Instances that resolve to the same physical directory are
     * reported together under each of their ids.
     */
    readonly readInstances: (input: {
      readonly days: number;
    }) => Effect.Effect<UsageInstancesSummary, UsageReadError>;
    readonly refreshRates: Effect.Effect<UsagePricing>;
  }
>()("t3/usage/UsageService") {}

const EMPTY_PRICING: UsagePricing = {
  status: "unavailable",
  source: LITELLM_RATES_URL,
  fetchedAt: null,
  knownModels: 0,
};

const layerTest = Layer.succeed(
  UsageService,
  UsageService.of({
    readSummary: (input) =>
      Effect.succeed({
        contractVersion: USAGE_CONTRACT_VERSION,
        readAt: "1970-01-01T00:00:00.000Z",
        timeZone: input.timeZone,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        buckets: [],
        sources: [],
        pricing: EMPTY_PRICING,
        scanDurationMs: 0,
      }),
    readInstances: () =>
      Effect.succeed({
        readAt: "1970-01-01T00:00:00.000Z",
        instances: [],
        pricing: EMPTY_PRICING,
        scanDurationMs: 0,
      }),
    refreshRates: Effect.succeed(EMPTY_PRICING),
  }),
);

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const hostEnvironment = yield* HostProcess.Environment;
  const readerContext = yield* Effect.context<BuiltInUsageReadersEnv>();

  const fileCache: ScanCache = new Map();
  const sourceCache = new Map<string, typeof CachedSource.Type>();
  let cacheDirty = false;
  const isWithinDirectory = (filePath: string, dir: string) => {
    const relative = path.relative(dir, filePath);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const scanCachePath = path.join(config.stateDir, SCAN_CACHE_FILE_NAME);
  const legacyScanCachePath = path.join(config.stateDir, LEGACY_SCAN_CACHE_FILE_NAME);
  const writeCacheFile = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  let rates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesLastFailedAtMs: number | null = null;
  let ratesStatus: UsagePricing["status"] = "unavailable";
  const ratesLock = yield* Semaphore.make(1);

  const pricing = (): UsagePricing => ({
    status: ratesStatus,
    source: LITELLM_RATES_URL,
    fetchedAt:
      ratesFetchedAtMs === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
    knownModels: rates.size,
  });

  const fetchRates = (url: string, accept = "application/json") =>
    httpClient.get(url, { headers: { accept } }).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.map((document) => {
        const parsed = parseRateTable(document);
        return parsed.size > 0 ? { document, parsed } : null;
      }),
      Effect.timeout(10_000),
      Effect.catchCause(() => Effect.succeed(null)),
    );

  const loadRates = Effect.fn("UsageService.loadRates")(function* (force: boolean) {
    const now = yield* Clock.currentTimeMillis;
    const maxAgeMs = force ? RATES_REFRESH_FLOOR_MS : RATES_TTL_MS;
    if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < maxAgeMs) return;

    if (ratesFetchedAtMs === null) {
      const fromDisk = yield* fileSystem.readFileString(ratesCachePath).pipe(
        Effect.flatMap((raw) => decodeRatesCache(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (fromDisk !== null) {
        const parsed = parseRateTable(fromDisk.document);
        if (parsed.size > 0) {
          rates = parsed;
          ratesFetchedAtMs = fromDisk.fetchedAtMs;
          ratesStatus = "cached";
          if (now - fromDisk.fetchedAtMs < maxAgeMs) return;
        }
      }
    }

    if (ratesLastFailedAtMs !== null && now - ratesLastFailedAtMs < RATES_REFRESH_FLOOR_MS) return;

    let fetched = yield* fetchRates(LITELLM_RATES_URL);
    if (fetched === null) {
      fetched = yield* fetchRates(LITELLM_RATES_API_URL, "application/vnd.github.raw+json");
    }
    if (fetched === null) {
      ratesLastFailedAtMs = yield* Clock.currentTimeMillis;
      if (rates.size > 0) ratesStatus = "cached";
      return;
    }

    rates = fetched.parsed;
    ratesFetchedAtMs = now;
    ratesLastFailedAtMs = null;
    ratesStatus = "fresh";

    yield* encodeRatesCache({ fetchedAtMs: now, document: fetched.document }).pipe(
      Effect.flatMap((contents) => writeCacheFile(ratesCachePath, contents)),
      Effect.ignoreCause,
    );
  });

  const ensureRates = (force: boolean) => ratesLock.withPermit(loadRates(force));

  const refreshRates = ensureRates(true).pipe(
    Effect.map(pricing),
    Effect.withSpan("UsageService.refreshRates"),
  );

  const readSettings = settingsService.getSettings.pipe(
    Effect.catchCause(
      (cause) =>
        new UsageReadError({
          reason: "scanFailed",
          detail: "Server settings could not be read.",
          cause: Cause.squash(cause),
        }),
    ),
  );

  const usageInstances = Effect.fn("UsageService.usageInstances")(function* <Config>(
    driver: ProviderDriver<Config, unknown, unknown>,
    settings: ServerSettingsValue,
  ) {
    const entries: Array<
      readonly [ProviderInstanceId, Pick<ProviderInstanceConfig, "config" | "environment">, boolean]
    > = Object.entries(settings.providerInstances)
      .filter(([, instance]) => instance.driver === driver.driverKind)
      .map(([id, instance]) => [ProviderInstanceId.make(id), instance, true] as const);
    if (!Object.hasOwn(settings.providerInstances, driver.driverKind)) {
      entries.push([ProviderInstanceId.make(driver.driverKind), {}, false]);
    }
    const decodeConfig = Schema.decodeUnknownOption(driver.configSchema);
    return yield* Effect.forEach(
      entries,
      Effect.fnUntraced(function* ([instanceId, instance, configured]) {
        const instanceConfig: ProviderUsageInstance<Config> = {
          instanceId,
          config: Option.getOrUndefined(decodeConfig(instance.config ?? {})),
          environment: yield* mergeProviderInstanceEnvironment(
            instance.environment,
            hostEnvironment,
          ),
          configured,
        };
        return instanceConfig;
      }),
    );
  });

  const resolveTranscriptDirs = Effect.fn("UsageService.resolveTranscriptDirs")(function* (
    settings: ServerSettingsValue,
    retentionCutoffMs: number,
  ) {
    const dirs: Array<TranscriptSource> = [];
    const seen = new Set<string>();
    for (const { driver, reader } of transcriptReaders) {
      const { provider, format } = reader;
      const directories = yield* Effect.forEach(
        yield* usageInstances(driver, settings),
        (instance) => reader.directories(instance),
      );
      for (const { dir: directory, fileName } of directories.flat()) {
        const sourceKey = provider + "\0" + directory;
        const previous = sourceCache.get(sourceKey);
        const dir = yield* fileSystem
          .realPath(directory)
          .pipe(Effect.orElseSucceed(() => previous?.dir ?? directory));
        const currentVolumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
        const hasRetainedHistory = fileCache
          .entries()
          .some(
            ([filePath, entry]) =>
              entry.provider === provider &&
              entry.mtimeMs >= retentionCutoffMs &&
              entry.records.length + entry.tailRecords.length > 0 &&
              isWithinDirectory(filePath, dir),
          );
        const volumeId =
          previous?.dir === dir && (hasRetainedHistory || !currentVolumeId)
            ? previous.volumeId || currentVolumeId
            : currentVolumeId;
        if (previous?.dir !== dir || previous.volumeId !== volumeId) {
          sourceCache.set(sourceKey, { dir, volumeId });
          cacheDirty = true;
        }
        const key = `${provider}\0${dir}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dirs.push({
          provider,
          format,
          dir,
          volumeId,
          ...(fileName === undefined ? {} : { fileName }),
        });
      }
    }
    return dirs;
  });

  /**
   * `Effect.cached` makes concurrent first readers await the same load rather
   * than each seeing a "loaded" flag set before the read finished and cold
   * scanning against an empty cache.
   */
  const ensureScanCacheLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const readDocument = (filePath: string) =>
        fileSystem.readFileString(filePath).pipe(
          Effect.flatMap((raw) => decodeScanCacheFile(raw)),
          Effect.catchCause(() => Effect.succeed(null)),
        );
      let document = yield* readDocument(scanCachePath);
      if (document === null) {
        document = yield* readDocument(legacyScanCachePath);
        cacheDirty = document !== null;
      }
      if (document === null) return;
      for (const [path, entry] of decodeScanCache(document, transcriptFormats)) {
        fileCache.set(path, entry);
      }
      const sources = decodeCachedSources(document);
      if (Option.isSome(sources)) {
        for (const [key, source] of Object.entries(sources.value.sources))
          sourceCache.set(key, source);
      }
    }),
  );

  const writeScanCache = makeScanCacheWriter();
  // Scans with different windows can finish together; serializing the writes
  // keeps an older snapshot from landing after a newer one.
  const persistLock = yield* Semaphore.make(1);

  // The dirty flag is cleared before encoding, so a change while the write is
  // in flight marks it dirty again. A failed write restores the flag, so the
  // next persist retries instead of leaving disk stale.
  const persistCaches = Effect.gen(function* () {
    if (cacheDirty) {
      cacheDirty = false;
      yield* Effect.sync(() =>
        writeScanCache(fileCache, { sources: Object.fromEntries(sourceCache) }),
      ).pipe(
        Effect.flatMap((contents) => writeCacheFile(scanCachePath, contents)),
        Effect.catchCause(() =>
          Effect.sync(() => {
            cacheDirty = true;
          }),
        ),
      );
    }
  }).pipe(persistLock.withPermit, Effect.withSpan("UsageService.persistCaches"));

  const pendingPersists = new Set<Fiber.Fiber<void>>();
  const schedulePersist = Effect.forkDetach(persistCaches).pipe(
    Effect.map((fiber) => {
      pendingPersists.add(fiber);
      fiber.addObserver(() => pendingPersists.delete(fiber));
    }),
  );
  const awaitPersisted = Effect.suspend(() => Fiber.awaitAll([...pendingPersists])).pipe(
    Effect.asVoid,
  );
  // A write still running when the service shuts down finishes first, so the
  // next start does not lose the last scan.
  yield* Effect.addFinalizer(() => awaitPersisted);

  /**
   * Reads run concurrently, and the caller stores updates in walk order rather
   * than completion order: saved records of deleted transcripts aggregate in
   * cache order, where the first copy of a duplicate wins.
   */
  const readFileRecords = (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
    format: TranscriptUsageFormat<unknown>,
  ): Effect.Effect<{
    readonly records: readonly UsageRecord[];
    readonly failed?: true;
    readonly update?: { readonly entry: CachedFile; readonly replaces: CachedFile | undefined };
  }> =>
    Effect.gen(function* () {
      const cached = fileCache.get(filePath);
      // Provider is part of the identity: if both providers were ever pointed
      // at one directory, a hit parsed by the other parser must not be reused.
      if (
        cached &&
        cached.size === size &&
        cached.mtimeMs === mtimeMs &&
        cached.provider === provider
      ) {
        return {
          records:
            cached.tailRecords.length === 0
              ? cached.records
              : [...cached.records, ...cached.tailRecords],
        };
      }

      // Only a strictly grown file may resume. Same size with a new mtime, or
      // a shrunken file, means rewritten content; re-parse it whole.
      const resumeFrom =
        cached !== undefined && cached.provider === provider && size > cached.size
          ? cached.position
          : undefined;

      const parsed = yield* Effect.promise(() =>
        readTranscriptRecords(filePath, format, resumeFrom),
      );
      // A read failure is not an empty transcript: caching it under this
      // (size, mtime) would silently drop the file's usage until it changes.
      if (parsed === null)
        return {
          records: cached?.provider === provider ? [...cached.records, ...cached.tailRecords] : [],
          failed: true,
        };

      const base = parsed.resumed && cached !== undefined ? cached.records : [];
      const seen = new Set<string>();
      const records = dedupeWithinFile([...base, ...parsed.records], seen);
      const tailRecords = dedupeWithinFile(parsed.tailRecords, seen);

      return {
        records: tailRecords.length === 0 ? records : [...records, ...tailRecords],
        update: {
          entry: { size, mtimeMs, provider, records, tailRecords, position: parsed.position },
          replaces: cached,
        },
      };
    });

  interface ScannedDir {
    readonly provider: UsageProviderKind;
    readonly dir: string;
    readonly volumeId: string;
    readonly hostId?: string;
    readonly status?: UsageSource["status"];
    readonly message?: string;
    readonly action?: UsageSource["action"];
    readonly files:
      | readonly { readonly path: string; readonly records: readonly UsageRecord[] }[]
      | null;
    readonly refreshing?: true;
    readonly instanceIds?: ReadonlyArray<ProviderInstanceId>;
  }

  const scanTranscriptDir = Effect.fn("UsageService.scanTranscriptDir")(function* (
    source: TranscriptSource,
    windowStartMs: number,
  ) {
    const { provider, format, dir, volumeId, fileName } = source;
    const exists = yield* fileSystem
      .exists(dir)
      .pipe(Effect.catchCause(() => Effect.succeed(false)));
    if (!exists) return { provider, dir, volumeId, files: null } satisfies ScannedDir;
    const { files, failedPaths } = yield* Effect.promise(() =>
      listTranscriptFiles(dir, windowStartMs, fileName === undefined ? undefined : { fileName }),
    );
    const read = yield* Effect.forEach(
      files,
      (file) =>
        readFileRecords(file.path, file.size, file.mtimeMs, provider, format).pipe(
          Effect.map((result) => ({ path: file.path, ...result })),
        ),
      { concurrency: TRANSCRIPT_READ_CONCURRENCY },
    );
    const parsedFiles = read.map(({ path, records, update }) => {
      if (update === undefined) return { path, records };
      // A scan of another window may have cached its own read of this file
      // meanwhile. Then keep whichever read saw the later file, so a slower
      // scan never replaces newer usage with older.
      const current = fileCache.get(path);
      if (
        current === update.replaces ||
        current === undefined ||
        !isLaterRead(current, update.entry)
      ) {
        fileCache.set(path, update.entry);
        cacheDirty = true;
      }
      return { path, records };
    });
    const unread = failedPaths + read.filter((file) => file.failed).length;
    return {
      provider,
      dir,
      volumeId,
      files: parsedFiles,
      ...(unread > 0
        ? {
            status: "partial",
            message: `${unread} transcript path(s) could not be read; usage may be incomplete.`,
          }
        : {}),
    } satisfies ScannedDir;
  });

  const collectDirs = Effect.fn("UsageService.collectDirs")(function* (
    windowStartMs: number,
    settings: ServerSettingsValue,
    retentionCutoffMs: number,
    awaitRefresh: boolean,
  ) {
    const dirs = yield* resolveTranscriptDirs(settings, retentionCutoffMs).pipe(
      Effect.provideContext(readerContext),
    );

    const scans = Effect.forEach(
      scanReaders,
      ({ driver, reader }) =>
        usageInstances(driver, settings)
          .pipe(
            Effect.flatMap((instances) =>
              reader.scan({ instances, settings, windowStartMs, retentionCutoffMs, awaitRefresh }),
            ),
          )
          .pipe(
            Effect.flatMap((sources) =>
              Effect.forEach(sources, ({ volumeId, ...source }) =>
                Effect.map(
                  volumeId === undefined
                    ? Effect.promise(() => readDirectoryVolumeId(source.dir))
                    : Effect.succeed(volumeId),
                  (resolved): ScannedDir => ({
                    ...source,
                    provider: reader.provider,
                    volumeId: resolved,
                  }),
                ),
              ),
            ),
            Effect.provideContext(readerContext),
          ),
      { concurrency: "unbounded" },
    );

    // Independent sources scan together. Transcript directories go one at a
    // time, so open files stay at `TRANSCRIPT_READ_CONCURRENCY`. The result
    // keeps this order, since aggregation keeps the first copy of a duplicate.
    const [transcripts, scanDirs] = yield* Effect.all(
      [Effect.forEach(dirs, (dir) => scanTranscriptDir(dir, windowStartMs)), scans],
      { concurrency: "unbounded" },
    );
    const scanned: readonly ScannedDir[] = [...transcripts, ...scanDirs.flat()];
    return scanned;
  });

  /**
   * Maps each configured instance to the transcript directories its driver
   * would read, so scanned usage can be attributed back to the instance the
   * user named in settings. Uses the same `reader.directories` the summary
   * scan goes through, so the two can never disagree about where a home is.
   */
  const instanceTranscriptDirs = Effect.fn("UsageService.instanceTranscriptDirs")(function* (
    settings: ServerSettingsValue,
  ) {
    const byDir = new Map<string, ReadonlyArray<string>>();
    for (const { driver, reader } of transcriptReaders) {
      if (reader.kind !== "transcripts") continue;
      const instances = yield* usageInstances(driver, settings);
      for (const instance of instances) {
        if (!instance.configured) continue;
        const directories = yield* reader.directories(instance).pipe(
          Effect.provideContext(readerContext),
          Effect.catchCause(() => Effect.succeed([] as const)),
        );
        for (const { dir } of directories) {
          const key = `${reader.provider}\0${dir}`;
          const owners = byDir.get(key) ?? [];
          // Two instances may resolve to one shared home (an alias); both ids
          // must carry that home's usage, so attribution never drops one.
          byDir.set(key, [...owners, instance.instanceId]);
        }
      }
    }
    return byDir;
  });

  /**
   * Attributes the trailing `days` of transcript usage to the configured
   * provider instances. Uses the same cached per-file records as the summary
   * scan; dedupe runs in-memory per directory because the keys encode the
   * aggregation window. Rates price each record directly, so a missing rate
   * shows up as `unpricedRecords` rather than a zero-cost bucket.
   */
  const scanInstances = Effect.fn("UsageService.scanInstances")(function* (
    days: number,
    settings: ServerSettingsValue,
  ) {
    const startedAtMs = yield* Clock.currentTimeMillis;
    yield* ensureScanCacheLoaded;

    // Midnight-to-midnight UTC arithmetic, so `days` counts calendar days
    // ending today rather than a rolling 24h multiple.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const todayStartMs = Math.floor(startedAtMs / DAY_MS) * DAY_MS;
    const sinceDayStartMs = todayStartMs - (days - 1) * DAY_MS;
    const windowStartMs = sinceDayStartMs - MTIME_SLACK_MS;
    const retentionCutoffMs = startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const [, scannedDirs, dirOwners] = yield* Effect.all(
      [
        ensureRates(false),
        collectDirs(windowStartMs, settings, retentionCutoffMs, false),
        instanceTranscriptDirs(settings),
      ],
      { concurrency: "unbounded" },
    );

    const overrides = createOverrideRateTable(settings.usagePriceOverrides);

    interface MutableInstance {
      totalTokens: number;
      costUsd: number;
      unpricedRecords: number;
      /** Present when the instance's transcript directory exists on disk. */
      hasDir: boolean;
      models: Map<string, { totalTokens: number; costUsd: number }>;
      /** Tokens since the start of today (UTC). */
      todayTokens: number;
      /** All-time tokens (unlimited history). */
      allTimeTokens: number;
      /** Billed credits (Kiro); null until a credit-metered record shows up. */
      creditsToday: number;
      creditsWindow: number;
      creditsAllTime: number;
      hasCredits: boolean;
    }
    const byInstance = new Map<string, MutableInstance>();
    const instanceEntry = (instanceKey: string): MutableInstance => {
      let entry = byInstance.get(instanceKey);
      if (entry === undefined) {
        entry = {
          totalTokens: 0,
          costUsd: 0,
          unpricedRecords: 0,
          hasDir: false,
          models: new Map(),
          todayTokens: 0,
          allTimeTokens: 0,
          creditsToday: 0,
          creditsWindow: 0,
          creditsAllTime: 0,
          hasCredits: false,
        };
        byInstance.set(instanceKey, entry);
      }
      return entry;
    };
    const accumulate = (
      entry: MutableInstance,
      record: Pick<UsageRecord, "model" | "rateModel" | "totals" | "speed" | "reportedCostUsd">,
    ): void => {
      const tokens = totalTokens(record.totals);
      if (tokens === 0 && record.reportedCostUsd === null) return;
      const priced = priceUsage(rates, record, overrides);
      entry.totalTokens += tokens;
      entry.costUsd += priced.costUsd;
      if (priced.costSource === "unpriced") entry.unpricedRecords += 1;
      const model = entry.models.get(record.model) ?? { totalTokens: 0, costUsd: 0 };
      model.totalTokens += tokens;
      model.costUsd += priced.costUsd;
      entry.models.set(record.model, model);
    };

    // Global deduplication for all-time tokens (across all files and directories)
    const allTimeSeen = new Set<string>();

    for (const scannedDir of scannedDirs) {
      const provider = scannedDir.provider;
      // Every configured instance claiming this physical directory shares the
      // attribution; a shared home carries its usage under each alias id.
      const ownerKeys =
        dirOwners.get(`${provider}\0${scannedDir.dir}`) ?? scannedDir.instanceIds ?? [];
      if (ownerKeys.length === 0) continue;
      const entries = ownerKeys.map((ownerKey) => instanceEntry(ownerKey));
      for (const entry of entries) {
        if (scannedDir.files !== null) entry.hasDir = true;
      }

      // Dedupe has to happen per record; UsageAggregator ties its seen-set to
      // a fixed day window, so fold the records here with the same rules.
      const seen = new Set<string>();
      for (const file of scannedDir.files ?? []) {
        for (const record of file.records) {
          const tokens = totalTokens(record.totals);
          const credits =
            typeof record.credits === "number" && Number.isFinite(record.credits)
              ? record.credits
              : 0;
          if (tokens === 0 && record.reportedCostUsd === null && credits === 0) continue;

          const isToday = record.timestampMs >= todayStartMs;
          const inWindow = record.timestampMs >= windowStartMs + MTIME_SLACK_MS;

          // Count all-time tokens (no time filter, global deduping)
          if (record.dedupeKey !== null) {
            if (!allTimeSeen.has(record.dedupeKey)) {
              allTimeSeen.add(record.dedupeKey);
              for (const entry of entries) {
                entry.allTimeTokens += tokens;
                if (credits > 0) {
                  entry.creditsAllTime += credits;
                  entry.hasCredits = true;
                }
                if (isToday) {
                  entry.todayTokens += tokens;
                  if (credits > 0) entry.creditsToday += credits;
                }
              }
            }
          } else {
            for (const entry of entries) {
              entry.allTimeTokens += tokens;
              if (credits > 0) {
                entry.creditsAllTime += credits;
                entry.hasCredits = true;
              }
              if (isToday) {
                entry.todayTokens += tokens;
                if (credits > 0) entry.creditsToday += credits;
              }
            }
          }

          // Count window-specific tokens
          if (!inWindow) continue;
          if (record.dedupeKey !== null) {
            if (seen.has(record.dedupeKey)) continue;
            seen.add(record.dedupeKey);
          }
          for (const entry of entries) {
            if (credits > 0) entry.creditsWindow += credits;
            accumulate(entry, record);
          }
        }
      }
    }

    const pruned = pruneScanCache(fileCache, retentionCutoffMs);
    if (pruned > 0) cacheDirty = true;

    const readAt = yield* DateTime.now;
    const finishedAtMs = yield* Clock.currentTimeMillis;

    const instances: Array<UsageInstancesSummary["instances"][number]> = [];
    for (const [instanceId, entry] of byInstance) {
      if (
        !entry.hasDir &&
        entry.totalTokens === 0 &&
        entry.costUsd === 0 &&
        entry.allTimeTokens === 0 &&
        !entry.hasCredits
      )
        continue;
      instances.push({
        instanceId: ProviderInstanceId.make(instanceId),
        usage: {
          available: true,
          totalTokens: Math.max(0, Math.round(entry.totalTokens)),
          costUsd: entry.costUsd,
          unpricedRecords: entry.unpricedRecords,
          todayTokens: Math.max(0, Math.round(entry.todayTokens)),
          allTimeTokens: Math.max(0, Math.round(entry.allTimeTokens)),
          ...(entry.hasCredits
            ? {
                credits: {
                  today: entry.creditsToday,
                  trailing7Days: entry.creditsWindow,
                  allTime: entry.creditsAllTime,
                },
              }
            : {}),
          models: [...entry.models.entries()]
            .map(([model, totals]) => ({
              model,
              totalTokens: Math.max(0, Math.round(totals.totalTokens)),
              costUsd: totals.costUsd,
            }))
            .sort((a, b) => b.totalTokens - a.totalTokens),
        },
      });
    }

    return {
      readAt: DateTime.formatIso(readAt),
      instances,
      pricing: pricing(),
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
    } satisfies UsageInstancesSummary;
  });

  const inflightInstanceScans = new Map<
    number,
    Deferred.Deferred<UsageInstancesSummary, UsageReadError>
  >();

  const readInstances = Effect.fn("UsageService.readInstances")(function* (input: {
    readonly days: number;
  }) {
    const days = Math.max(
      1,
      Math.min(31, Math.floor(Number.isFinite(input.days) ? input.days : 7)),
    );
    const settings = yield* readSettings;
    const deferred = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const existing = inflightInstanceScans.get(days);
        if (existing !== undefined) return existing;
        const created = Deferred.makeUnsafe<UsageInstancesSummary, UsageReadError>();
        inflightInstanceScans.set(days, created);
        yield* scanInstances(days, settings).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => inflightInstanceScans.delete(days)).pipe(
              Effect.andThen(Deferred.done(created, exit)),
            ),
          ),
          Effect.forkDetach,
        );
        return created;
      }),
    );
    return yield* Deferred.await(deferred);
  });

  const scanSummary = Effect.fn("UsageService.scanSummary")(function* (
    input: UsageSummaryInput,
    settings: ServerSettingsValue,
  ) {
    if (input.sinceDay > input.untilDay) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }

    let hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null = null;
    if (input.resolution === "hour") {
      const sinceTime =
        input.sinceTime === undefined ? Option.none() : DateTime.make(input.sinceTime);
      const untilTime =
        input.untilTime === undefined ? Option.none() : DateTime.make(input.untilTime);
      if (Option.isNone(sinceTime) || Option.isNone(untilTime)) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage requires valid sinceTime and untilTime instants",
        });
      }
      const sinceTimeMs = DateTime.toEpochMillis(sinceTime.value);
      const untilTimeMs = DateTime.toEpochMillis(untilTime.value);
      const durationMs = untilTimeMs - sinceTimeMs;
      if (durationMs <= 0 || durationMs > MAX_HOURLY_WINDOW_MS) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage window must be greater than zero and at most 24 hours",
        });
      }
      hourlyWindow = { sinceTimeMs, untilTimeMs };
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    yield* ensureScanCacheLoaded;

    const hostId = NodeOS.hostname();
    const windowStart = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    if (Option.isNone(windowStart)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is not a valid date`,
      });
    }
    const windowStartMs =
      (hourlyWindow?.sinceTimeMs ?? DateTime.toEpochMillis(windowStart.value)) - MTIME_SLACK_MS;

    const retentionCutoffMs = startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const [, scannedDirs] = yield* Effect.all(
      [
        ensureRates(false),
        collectDirs(windowStartMs, settings, retentionCutoffMs, input.awaitRefresh === true),
      ],
      { concurrency: 2 },
    );

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates,
      priceOverrides: createOverrideRateTable(settings.usagePriceOverrides),
      modelAliases: resolveModelAliases(settings.usageModelAliases),
    });

    const sources: UsageSource[] = [];

    // Cleanup may remove transcripts, but the usage we already saved still
    // contributes to its source through the normal aggregation and dedupe path.
    const retainedSinceMs = Math.max(windowStartMs, retentionCutoffMs);
    const filesByDir = scannedDirs.map(({ provider, dir, files }) => {
      const retainedFiles = [...(files ?? [])];
      const livePaths = new Set(retainedFiles.map((file) => file.path));
      for (const [filePath, entry] of fileCache) {
        if (
          entry.provider !== provider ||
          entry.mtimeMs < retainedSinceMs ||
          livePaths.has(filePath) ||
          !isWithinDirectory(filePath, dir)
        )
          continue;
        retainedFiles.push({ path: filePath, records: [...entry.records, ...entry.tailRecords] });
      }
      return retainedFiles;
    });
    const crossFileSessions = sharedSessions(filesByDir.flat());

    for (const [
      index,
      { provider, dir, volumeId, files, status, message, action, refreshing, hostId: sourceHostId },
    ] of scannedDirs.entries()) {
      let scannedFiles = 0;
      let skippedFiles = 0;
      // Distinct per directory. Buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead.
      const sessionIds = new Set<string>();

      for (const file of filesByDir[index] ?? []) {
        if (file.records.length === 0) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        const eventOccurrences = new Map<string, number>();
        for (const record of file.records) {
          let usageRecord = record;
          if (
            sharedSessionProviders.has(record.provider) &&
            crossFileSessions.has(record.sessionId)
          ) {
            // Match moved copies without collapsing repeated equal events
            // within one file (timestamps can have only second precision).
            const key = encodeUsageRecordKey([
              record.provider,
              record.sessionId,
              record.timestampMs,
              record.model,
              record.totals,
            ]);
            const occurrence = (eventOccurrences.get(key) ?? 0) + 1;
            eventOccurrences.set(key, occurrence);
            usageRecord = { ...record, dedupeKey: key + ":" + occurrence };
          }
          if (aggregator.add(usageRecord, dir) && record.sessionId.length > 0) {
            sessionIds.add(record.sessionId);
          }
        }
      }

      sources.push({
        fingerprint: { hostId: sourceHostId ?? hostId, provider, resolvedHomePath: dir, volumeId },
        status: files === null && scannedFiles === 0 ? "missing" : (status ?? "ok"),
        scannedFiles,
        skippedFiles,
        malformedRecords: 0,
        distinctSessions: sessionIds.size,
        message:
          message ?? (files === null ? "No transcript directory on this environment." : null),
        ...(action ? { action } : {}),
        ...(refreshing ? { refreshing } : {}),
      });
    }

    const pruned = pruneScanCache(fileCache, retentionCutoffMs);
    if (pruned > 0) cacheDirty = true;

    const aggregated = aggregator.finish();
    const readAt = yield* DateTime.now;
    const finishedAtMs = yield* Clock.currentTimeMillis;

    return {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: aggregated.buckets,
      sources,
      pricing: pricing(),
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
    } satisfies UsageSummary;
  });

  const inflightScans = new Map<string, Deferred.Deferred<UsageSummary, UsageReadError>>();

  const scanKey = (input: UsageSummaryInput, settings: ServerSettingsValue): string =>
    JSON.stringify([
      input.timeZone,
      input.sinceDay,
      input.untilDay,
      input.resolution ?? "day",
      input.sinceTime ?? null,
      input.untilTime ?? null,
      settings,
      input.awaitRefresh === true,
    ]);

  const readSummary = Effect.fn("UsageService.readSummary")(function* (input: UsageSummaryInput) {
    const settings = yield* readSettings;
    const key = scanKey(input, settings);
    const deferred = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const existing = inflightScans.get(key);
        if (existing !== undefined) return existing;

        // Enrollment and detached-fiber creation must be atomic. Otherwise a
        // canceled first caller can leave a Deferred with no scan to finish it.
        const created = Deferred.makeUnsafe<UsageSummary, UsageReadError>();
        inflightScans.set(key, created);
        // Detached so one departing client cannot tear the scan out from under
        // the fibers awaiting it; a finished scan warms the cache either way.
        // The cache write is registered before the waiters resume, so they
        // can await it, but its fiber starts after they have the summary.
        yield* scanSummary(input, settings).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => inflightScans.delete(key)).pipe(
              Effect.andThen(Exit.isSuccess(exit) ? schedulePersist : Effect.void),
              Effect.andThen(Deferred.done(created, exit)),
            ),
          ),
          Effect.forkDetach,
        );
        return created;
      }),
    );
    return yield* Deferred.await(deferred);
  });

  return { readSummary, readInstances, refreshRates, awaitPersisted } as const;
});

export const layer = Layer.effect(UsageService, make);
