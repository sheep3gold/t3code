import {
  type CustomModelSetting,
  type FactorySettings,
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

const PRESENTATION = {
  displayName: "Factory Droid",
  supportsConversationRollback: false,
  badgeLabel: "Fork",
  showInteractionModeToggle: false,
  reportsContextWindow: false,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const VERSION_TIMEOUT_MS = 4_000;
/**
 * `droid` reports its model list only inside a live ACP session, so the
 * catalog is pinned here (ids and token-rate multipliers copied from
 * `session/new`). Models Factory adds later are reachable through custom
 * models until this list is refreshed.
 */
const MODEL_ROWS = [
  ["auto", "Auto Model · 1x"],
  ["claude-fable-5.1", "Fable 5.1 · 4x"],
  ["claude-fable-5", "Fable 5 · 4x"],
  ["claude-opus-5-5", "Opus 5.5 · 1.6x"],
  ["claude-opus-5-5-fast", "Opus 5.5 Fast Mode · 3.2x"],
  ["claude-opus-5", "Opus 5 · 2x"],
  ["claude-opus-5-fast", "Opus 5 Fast Mode · 4x"],
  ["claude-opus-4-8", "Opus 4.8 · 2x"],
  ["claude-opus-4-8-fast", "Opus 4.8 Fast Mode · 4x"],
  ["claude-opus-4-7", "Opus 4.7 · 2x"],
  ["claude-opus-4-6", "Opus 4.6 · 2x"],
  ["claude-opus-4-5-20251101", "Opus 4.5 · 2x"],
  ["claude-sonnet-5-5", "Sonnet 5.5 · 0.8x"],
  ["claude-sonnet-5", "Sonnet 5 · 0.8x"],
  ["claude-sonnet-4-6", "Sonnet 4.6 · 1.2x"],
  ["claude-sonnet-4-5-20250929", "Sonnet 4.5 · 1.2x"],
  ["claude-haiku-4-5-20251001", "Haiku 4.5 · 0.4x"],
  ["gpt-6.1-sol", "GPT-6.1 Sol · 0.8x"],
  ["gpt-6-astra", "GPT-6 Astra · 4x"],
  ["gpt-6-sol", "GPT-6 Sol · 0.8x"],
  ["gpt-6-luna", "GPT-6 Luna · 0.04x"],
  ["gpt-5.6-sol", "GPT-5.6 Sol · 1.6x"],
  ["gpt-5.6-sol-fast", "GPT-5.6 Sol Fast Mode · 3.2x"],
  ["gpt-5.6-terra", "GPT-5.6 Terra · 0.8x"],
  ["gpt-5.6-luna", "GPT-5.6 Luna · 0.08x"],
  ["gpt-5.5", "GPT-5.5 · 2x"],
  ["gpt-5.5-fast", "GPT-5.5 Fast Mode · 5x"],
  ["gpt-5.5-pro", "GPT-5.5 Pro · 12x"],
  ["gpt-5.4", "GPT-5.4 · 1x"],
  ["gpt-5.4-fast", "GPT-5.4 Fast Mode · 2x"],
  ["gpt-5.4-mini", "GPT-5.4 Mini · 0.3x"],
  ["gpt-5.4-mini-fast", "GPT-5.4 Mini Fast Mode · 0.6x"],
  ["gpt-5.3-codex", "GPT-5.3-Codex · 0.7x"],
  ["gpt-5.3-codex-fast", "GPT-5.3-Codex Fast Mode · 1.4x"],
  ["gpt-5.2", "GPT-5.2 · 0.7x"],
  ["gemini-3.1-pro-preview", "Gemini 3.1 Pro · 0.8x"],
  ["gemini-3.8-flash", "Gemini 3.8 Flash · 0.3x"],
  ["gemini-3.7-flash", "Gemini 3.7 Flash · 0.3x"],
  ["gemini-3.6-flash", "Gemini 3.6 Flash · 0.6x"],
  ["gemini-3.5-flash", "Gemini 3.5 Flash · 0.6x"],
  ["gemini-3-flash-preview", "Gemini 3 Flash · 0.2x"],
  ["inkling", "Inkling · 0.4x"],
  ["mistral-medium-3.5", "Mistral Medium 3.5 · 0.6x"],
  ["glm-5.3-flash", "GLM-5.3-Flash · 0.06x"],
  ["glm-5.3", "GLM-5.3 · 0.56x"],
  ["glm-5.2", "GLM-5.2 · 0.56x"],
  ["glm-5.2-fast", "GLM-5.2 Fast · 0.84x"],
  ["kimi-k3", "Kimi K3 · 1.2x"],
  ["qwen3.8-max", "Qwen3.8 Max · 0.8x"],
  ["nemotron-3-ultra", "Nemotron 3 Ultra · 0.24x"],
  ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash · 0.12x"],
  ["deepseek-v4-flash-0731", "DeepSeek V4 Flash 0731 [Deprecated] · 0.176x"],
  ["deepseek-v4-pro", "DeepSeek V4 Pro [Deprecated] · 0.528x"],
  ["minimax-m3", "MiniMax M3 · 0.12x"],
  ["grok-4.7", "Grok 4.7 · 0.8x"],
  ["grok-4.6", "Grok 4.6 · 0.8x"],
  ["grok-4.5", "Grok 4.5 · 0.8x"],
  ["minimax-m2.7", "MiniMax M2.7 [Deprecated] · 0.12x"],
] as const;
export const FACTORY_MODELS: ReadonlyArray<ServerProviderModel> = MODEL_ROWS.map(
  ([slug, name]) => ({ slug, name, isCustom: false, capabilities: EMPTY }),
);
const models = (custom: ReadonlyArray<CustomModelSetting>) =>
  providerModelsFromSettings(FACTORY_MODELS, custom, EMPTY);

export function buildInitialFactoryProviderSnapshot(
  settings: FactorySettings,
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
            message: "Checking Factory Droid availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Factory Droid is disabled in T3 Code settings.",
          },
    });
  });
}

export function checkFactoryProviderStatus(
  settings: FactorySettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Effect.Effect<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    if (!settings.enabled) return yield* buildInitialFactoryProviderSnapshot(settings);
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const binary = settings.binaryPath?.trim() || "droid";
    const hasApiKey = Boolean(environment.FACTORY_API_KEY?.trim());
    const result = yield* Effect.gen(function* () {
      const spawn = yield* resolveSpawnCommand(binary, ["--version"], { env: environment });
      return yield* spawnAndCollect(
        binary,
        ChildProcess.make(spawn.command, spawn.args, {
          env: environment,
          shell: spawn.shell,
          cwd,
        }),
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
          ? `Factory Droid CLI not found at '${binary}'.`
          : "Factory Droid CLI did not respond to --version.",
      };
    else if (result.success.code !== 0)
      probe = {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Factory Droid CLI version probe failed.",
      };
    else
      probe = {
        installed: true,
        version: parseGenericCliVersion(result.success.stdout),
        status: hasApiKey ? "ready" : "warning",
        auth: { status: "unknown" },
        message: hasApiKey
          ? "Factory Droid is ready; the API key is verified on the first turn."
          : "FACTORY_API_KEY is not set for the server; Droid falls back to its local sign-in.",
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

export const enrichFactorySnapshot = (input: {
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
