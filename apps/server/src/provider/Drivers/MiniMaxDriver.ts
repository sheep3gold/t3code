import { MiniMaxSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as PathService from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeMiniMaxTextGeneration } from "../../textGeneration/MiniMaxTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeMiniMaxAdapter } from "../Layers/MiniMaxAdapter.ts";
import {
  buildInitialMiniMaxProviderSnapshot,
  checkMiniMaxProviderStatus,
  enrichMiniMaxSnapshot,
} from "../Layers/MiniMaxProvider.ts";
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
const decode = Schema.decodeSync(MiniMaxSettings);
const DRIVER = ProviderDriverKind.make("minimax");
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER,
  packageName: "@minimax-ai/code",
});
export type MiniMaxDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | HttpClient.HttpClient
  | PathService.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;
export const MiniMaxDriver: ProviderDriver<MiniMaxSettings, MiniMaxDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "MiniMax Code", supportsMultipleInstances: true },
  configSchema: MiniMaxSettings,
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
      const settings = { ...config, enabled } satisfies MiniMaxSettings;
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
      const adapter = yield* makeMiniMaxAdapter(settings, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeMiniMaxTextGeneration(settings, processEnv);
      const checkProvider = checkMiniMaxProviderStatus(settings, processEnv, cwd).pipe(
        Effect.map(stamp),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const source = makeProviderSnapshotSettingsSource(settings, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<MiniMaxSettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE),
        getSettings: source.getSettings,
        streamSettings: source.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (s) =>
          buildInitialMiniMaxProviderSnapshot(s.provider).pipe(Effect.map(stamp)),
        checkProvider,
        enrichSnapshot: ({ settings: s, snapshot, publishSnapshot }) =>
          enrichMiniMaxSnapshot({
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
              detail: `Failed to build MiniMax snapshot: ${cause.message ?? String(cause)}`,
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
