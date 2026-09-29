import {
  type CustomModelSetting,
  type MiniMaxSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { miniMaxProcessEnvironment } from "../acp/MiniMaxAcpSupport.ts";

const PRESENTATION = {
  displayName: "MiniMax Code",
  supportsConversationRollback: false,
  badgeLabel: "Fork",
  showInteractionModeToggle: true,
  reportsContextWindow: false,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const VERSION_TIMEOUT_MS = 4_000;
const MODEL_ROWS = [
  ["m:custom_provider%3Aminimax-official-api:MiniMax-M3:v:thinking", "MiniMax M3 · thinking"],
  ["m:custom_provider%3Aminimax-official-api:MiniMax-M2.7:v:thinking", "MiniMax M2.7 · thinking"],
  [
    "m:custom_provider%3Aminimax-official-api:MiniMax-M2.7-highspeed:v:thinking",
    "MiniMax M2.7 Highspeed · thinking",
  ],
  ["m:custom_provider%3Aminimax-official-api:MiniMax-M2.5:v:thinking", "MiniMax M2.5 · thinking"],
  [
    "m:custom_provider%3Aminimax-official-api:MiniMax-M2.5-highspeed:v:thinking",
    "MiniMax M2.5 Highspeed · thinking",
  ],
  ["m:custom_provider%3Aminimax-official-api:MiniMax-M2.1:v:thinking", "MiniMax M2.1 · thinking"],
  [
    "m:custom_provider%3Aminimax-official-api:MiniMax-M2.1-highspeed:v:thinking",
    "MiniMax M2.1 Highspeed · thinking",
  ],
  ["m:custom_provider%3Aminimax-official-api:MiniMax-M2:v:thinking", "MiniMax M2 · thinking"],
] as const;
export const MINIMAX_MODELS: ReadonlyArray<ServerProviderModel> = MODEL_ROWS.map(
  ([slug, name]) => ({ slug, name, isCustom: false, capabilities: EMPTY }),
);
const models = (custom: ReadonlyArray<CustomModelSetting>) =>
  providerModelsFromSettings(MINIMAX_MODELS, custom, EMPTY);

export function buildInitialMiniMaxProviderSnapshot(
  settings: MiniMaxSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: models(settings.customModels),
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking MiniMax Code availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "MiniMax Code is disabled in T3 Code settings.",
          },
    });
  });
}
export function checkMiniMaxProviderStatus(
  settings: MiniMaxSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Effect.Effect<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    if (!settings.enabled) return yield* buildInitialMiniMaxProviderSnapshot(settings);
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const binary = settings.binaryPath?.trim() || "mcode";
    const env = miniMaxProcessEnvironment(settings, environment);
    const result = yield* Effect.gen(function* () {
      const spawn = yield* resolveSpawnCommand(binary, ["--version"], { env });
      return yield* spawnAndCollect(
        binary,
        ChildProcess.make(spawn.command, spawn.args, { env, shell: spawn.shell, cwd }),
      );
    }).pipe(Effect.timeout(VERSION_TIMEOUT_MS), Effect.result);
    let probe: ProviderProbeResult;
    if (Result.isFailure(result))
      probe = {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(result.failure)
          ? `MiniMax Code CLI not found at '${binary}'.`
          : "MiniMax Code CLI did not respond to --version.",
      };
    else if (result.success.code !== 0)
      probe = {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "MiniMax Code CLI version probe failed.",
      };
    else
      probe = {
        installed: true,
        version: parseGenericCliVersion(result.success.stdout),
        status: "ready",
        auth: { status: "unknown" },
        message: "MiniMax Code is ready; credentials are verified on the first turn.",
      };
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: models(settings.customModels),
      probe,
    });
  });
}
export const enrichMiniMaxSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}) =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap(input.publishSnapshot),
  );
