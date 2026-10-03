import { FactorySettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as PathService from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeFactoryTextGeneration } from "../../textGeneration/FactoryTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeFactoryAdapter } from "../Layers/FactoryAdapter.ts";
import {
  buildInitialFactoryProviderSnapshot,
  checkFactoryProviderStatus,
  enrichFactorySnapshot,
} from "../Layers/FactoryProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
const decode = Schema.decodeSync(FactorySettings);
const DRIVER = ProviderDriverKind.make("factory");
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER,
  packageName: null,
});
export type FactoryDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | HttpClient.HttpClient
  | PathService.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;
export const FactoryDriver: ProviderDriver<FactorySettings, FactoryDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "Factory Droid", supportsMultipleInstances: true },
  configSchema: FactorySettings,
  defaultConfig: () => decode({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const { cwd } = yield* ServerConfig;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const settings = { ...config, enabled } satisfies FactorySettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId,
      });
      const stamp = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const adapter = yield* makeFactoryAdapter(settings, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeFactoryTextGeneration(settings, processEnv);
      const checkProvider = checkFactoryProviderStatus(settings, processEnv, cwd).pipe(
        Effect.map(stamp),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const source = makeProviderSnapshotSettingsSource(settings, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<FactorySettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE),
        getSettings: source.getSettings,
        streamSettings: source.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (s) =>
          buildInitialFactoryProviderSnapshot(s.provider).pipe(Effect.map(stamp)),
        checkProvider,
        enrichSnapshot: ({ settings: s, snapshot, publishSnapshot }) =>
          enrichFactorySnapshot({
            snapshot,
            maintenanceCapabilities: MAINTENANCE,
            enableProviderUpdateChecks: s.enableProviderUpdateChecks,
            publishSnapshot,
            httpClient,
          }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: `Failed to build Factory snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
