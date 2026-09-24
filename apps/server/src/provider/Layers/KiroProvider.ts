/**
 * KiroProvider — snapshot, probe and model catalog for the Kiro CLI provider.
 *
 * Kiro CLI is an AWS product driven here over ACP (`kiro-cli acp`). Unlike
 * Grok — which exposes a single product slug and lets its own session decide
 * the model — kiro-cli has a real model list with per-model credit
 * multipliers, so the catalog below is the full list and the picker shows all
 * of it.
 *
 * Two things about the slugs are load-bearing:
 *
 *   * They are kiro-cli's own ids and are passed through verbatim. Its list
 *     uses dots (`claude-haiku-4.5`, `deepseek-3.2`, `gpt-5.6-sol`) where
 *     T3's Claude catalog uses dashes (`claude-fable-5-1`). Rewriting them to
 *     match T3's house style makes kiro-cli reject the model.
 *   * `auto` is not a model but a router ("models chosen by task"), which is
 *     why it is listed first and billed at 1.00x.
 *
 * @module provider/Layers/KiroProvider
 */
import {
  type CustomModelSetting,
  type KiroSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
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

const KIRO_PRESENTATION = {
  displayName: "Kiro",
  // kiro-cli's ACP session cannot roll back its conversation, so the
  // checkpoint boundary must reject revert before touching the filesystem.
  // Claiming otherwise would let T3 revert files against a provider
  // conversation that still believes the old turn happened.
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  // kiro-cli reports `contextUsagePercentage` on every turn, so T3 can show
  // real context pressure instead of guessing.
  reportsContextWindow: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const AUTH_PROBE_TIMEOUT_MS = 10_000;

/**
 * Credit multipliers are from `kiro-cli chat --list-models` and are shown in
 * the picker so an expensive choice is a deliberate one. They are presentation
 * only — billing happens on the AWS side regardless of what this says.
 */
const KIRO_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  { slug: "auto", name: "Auto (1.00x)" },
  { slug: "claude-opus-5", name: "Claude Opus 5 (2.20x)" },
  { slug: "claude-sonnet-5", name: "Claude Sonnet 5 (1.30x)" },
  { slug: "claude-opus-4.6", name: "Claude Opus 4.6 (2.20x)" },
  { slug: "claude-haiku-4.5", name: "Claude Haiku 4.5 (0.40x)" },
  // Retained inputs/outputs: AWS keeps traffic for automated abuse detection
  // and may human-review anything it flags. Said plainly in the label so it
  // is not discovered after the fact.
  { slug: "claude-fable-5.1", name: "Claude Fable 5.1 (6.00x · AWS retains I/O)" },
  { slug: "gpt-5.6-sol", name: "GPT 5.6 Sol (4.40x)" },
  { slug: "gpt-5.6-terra", name: "GPT 5.6 Terra (2.20x)" },
  { slug: "gpt-5.6-luna", name: "GPT 5.6 Luna (1.10x)" },
  { slug: "deepseek-3.2", name: "DeepSeek V3.2 (0.25x)" },
  { slug: "minimax-m2.5", name: "MiniMax M2.5 (0.25x)" },
  { slug: "glm-5", name: "GLM-5 (0.50x)" },
].map((model) => ({ ...model, isCustom: false, capabilities: EMPTY_CAPABILITIES }));

function kiroModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting>,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(KIRO_BUILT_IN_MODELS, customModels, EMPTY_CAPABILITIES);
}

/** Snapshot shown before any probe has run, so the UI has something truthful. */
export function buildInitialKiroProviderSnapshot(
  settings: KiroSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = kiroModelsFromSettings(settings.customModels);

    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Kiro CLI availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Kiro is disabled in T3 Code settings.",
          },
    });
  });
}

/**
 * Probe the binary and the signed-in account.
 *
 * Deliberately two separate spawns rather than one: `--version` proves the
 * binary runs, `whoami` proves the account. Collapsing them would report an
 * unauthenticated install as "not installed", which sends the user to the
 * installer instead of to `kiro-cli login`.
 *
 * Neither probe opens a session or starts MCP servers — setup must not happen
 * as a health-check side effect.
 */
export function checkKiroProviderStatus(
  settings: KiroSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Effect.Effect<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = kiroModelsFromSettings(settings.customModels);

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: KIRO_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kiro is disabled in T3 Code settings.",
        },
      });
    }

    const binaryPath = settings.binaryPath?.trim() || "kiro-cli";
    const probe = yield* probeKiro(binaryPath, environment, cwd);

    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe,
    });
  });
}

function probeKiro(
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Effect.Effect<ProviderProbeResult, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const versionResult = yield* runKiro(binaryPath, ["--version"], environment, cwd).pipe(
      Effect.timeout(VERSION_PROBE_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionResult)) {
      const missing = isCommandMissingCause(versionResult.failure);
      return {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? `Kiro CLI not found at '${binaryPath}'. Install it or set the binary path in settings.`
          : `Kiro CLI did not respond to --version.`,
      } satisfies ProviderProbeResult;
    }

    // `Effect.timeout` here fails the error channel rather than yielding an
    // Option, so a timeout is already covered by the isFailure branch above.
    const version = parseGenericCliVersion(versionResult.success.stdout);

    const whoamiResult = yield* runKiro(binaryPath, ["whoami"], environment, cwd).pipe(
      Effect.timeout(AUTH_PROBE_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(whoamiResult)) {
      return {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not read Kiro sign-in state.",
      } satisfies ProviderProbeResult;
    }

    const output = whoamiResult.success;
    // `whoami` exits non-zero when nobody is signed in. Reading the account
    // out of stdout rather than trusting the exit code alone keeps a future
    // exit-code change from silently reporting everyone as authenticated.
    const signedIn = output.code === 0 && /Logged in/i.test(output.stdout);
    if (!signedIn) {
      return {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unauthenticated" },
        message: "Kiro CLI is installed but not signed in. Run `kiro-cli login`.",
      } satisfies ProviderProbeResult;
    }

    const email = output.stdout.match(/^Email:\s*(.+)$/m)?.[1]?.trim();
    const auth: ServerProviderAuth = email
      ? { status: "authenticated", type: "cached_token", label: "Kiro account", email }
      : { status: "authenticated", type: "cached_token", label: "Kiro account" };

    return { installed: true, version, status: "ready", auth } satisfies ProviderProbeResult;
  });
}

function runKiro(
  binaryPath: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  return Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(binaryPath, args, { env: environment });
    return yield* spawnAndCollect(
      binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
        cwd,
      }),
    );
  });
}

export const enrichKiroSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    // A failed advisory lookup must not take the snapshot down with it: the
    // provider is perfectly usable without knowing whether a newer CLI exists.
    Effect.catchCause((cause) =>
      Effect.logWarning("Kiro version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
