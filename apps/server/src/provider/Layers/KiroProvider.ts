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
  // The model is fixed when the ACP process spawns (`acp --model`); kiro-cli
  // exposes no `session/set_model`. Telling the UI up front is what keeps a
  // mid-thread switch from becoming a failed turn.
  requiresNewThreadForModelChange: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const AUTH_PROBE_TIMEOUT_MS = 10_000;
const MODEL_LIST_PROBE_TIMEOUT_MS = 6_000;

/**
 * Curated presentation for the models kiro-cli shipped when this was written.
 *
 * This table has two jobs, and neither is "the list of models":
 *
 *   * Fallback catalog when `--list-models` cannot be read — an older binary,
 *     an offline probe, or an output format that stops parsing.
 *   * Label source when the live list DOES parse. kiro-cli's own descriptions
 *     are sentences ("Experimental preview of OpenAI GPT 5.6 Sol with 1M
 *     context window"), far too long for a picker row.
 *
 * A slug absent from here is still offered: the live list decides membership
 * and this table only supplies nicer names. That is the entire point of
 * reading the list at probe time — a model AWS adds next month shows up
 * without a code change here.
 *
 * Credit multipliers are presentation only. Billing happens on the AWS side
 * regardless of what this says, so they exist to make an expensive choice a
 * deliberate one.
 */
const KIRO_KNOWN_MODELS: ReadonlyArray<{
  readonly slug: string;
  readonly label: string;
  readonly multiplier: string;
  readonly retainsIo?: true;
}> = [
  { slug: "auto", label: "Auto", multiplier: "1.00x" },
  { slug: "claude-opus-5", label: "Claude Opus 5", multiplier: "2.20x" },
  { slug: "claude-sonnet-5", label: "Claude Sonnet 5", multiplier: "1.30x" },
  { slug: "claude-opus-4.6", label: "Claude Opus 4.6", multiplier: "2.20x" },
  { slug: "claude-haiku-4.5", label: "Claude Haiku 4.5", multiplier: "0.40x" },
  // Retained inputs/outputs: AWS keeps traffic for automated abuse detection
  // and may human-review anything it flags. Said plainly in the label so it
  // is not discovered after the fact.
  { slug: "claude-fable-5.1", label: "Claude Fable 5.1", multiplier: "6.00x", retainsIo: true },
  { slug: "gpt-5.6-sol", label: "GPT 5.6 Sol", multiplier: "4.40x" },
  { slug: "gpt-5.6-terra", label: "GPT 5.6 Terra", multiplier: "2.20x" },
  { slug: "gpt-5.6-luna", label: "GPT 5.6 Luna", multiplier: "1.10x" },
  { slug: "deepseek-3.2", label: "DeepSeek V3.2", multiplier: "0.25x" },
  { slug: "minimax-m2.5", label: "MiniMax M2.5", multiplier: "0.25x" },
  { slug: "glm-5", label: "GLM-5", multiplier: "0.50x" },
];

const KIRO_MODEL_LABELS = new Map(KIRO_KNOWN_MODELS.map((model) => [model.slug, model.label]));

const formatKiroModelName = (label: string, multiplier: string, retainsIo: boolean): string =>
  retainsIo ? `${label} (${multiplier} · AWS retains I/O)` : `${label} (${multiplier})`;

const KIRO_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = KIRO_KNOWN_MODELS.map((model) => ({
  slug: model.slug,
  name: formatKiroModelName(model.label, model.multiplier, model.retainsIo === true),
  isCustom: false,
  capabilities: EMPTY_CAPABILITIES,
}));

/**
 * One row of `kiro-cli chat --list-models`, e.g.
 *
 * ```
 * * claude-sonnet-5     1.30x credits      Claude Sonnet 5 model with 1M context window
 * ```
 *
 * The leading `*` marks kiro-cli's own default and is ignored here: T3 carries
 * its own per-provider default, which the user may have chosen differently.
 *
 * Text parsing is not a shortcut — `--output-format` accepts only `text` and
 * `stream-json`, and `--list-models` has no JSON form, so this is the only
 * shape on offer.
 */
const KIRO_MODEL_LIST_LINE =
  /^\s*\*?\s*([A-Za-z0-9._:-]+)\s{2,}([0-9]+(?:\.[0-9]+)?x)\s+credits\s{2,}(.*)$/;

/** Readable name for a slug this build has never heard of. */
const humanizeKiroSlug = (slug: string): string =>
  slug
    .split("-")
    .map((part) => (/^[a-z]/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");

export function parseKiroModelList(stdout: string): ReadonlyArray<ServerProviderModel> {
  const models: ServerProviderModel[] = [];
  const seen = new Set<string>();

  for (const line of stdout.split("\n")) {
    const match = KIRO_MODEL_LIST_LINE.exec(line);
    if (match === null) continue;
    const [, slug, multiplier, description] = match;
    if (slug === undefined || multiplier === undefined) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);

    // Detect retained-I/O from kiro-cli's own wording rather than a hardcoded
    // slug, so a future model carrying the same terms is flagged too.
    const retainsIo = /retain inputs and outputs/i.test(description ?? "");
    const label = KIRO_MODEL_LABELS.get(slug) ?? humanizeKiroSlug(slug);
    models.push({
      slug,
      name: formatKiroModelName(label, multiplier, retainsIo),
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    });
  }

  return models;
}

function kiroModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting>,
  discovered?: ReadonlyArray<ServerProviderModel> | undefined,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    discovered ?? KIRO_BUILT_IN_MODELS,
    customModels,
    EMPTY_CAPABILITIES,
  );
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

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: KIRO_PRESENTATION,
        enabled: false,
        checkedAt,
        // Fallback catalog: a disabled provider is never probed, so there is
        // no live list to read.
        models: kiroModelsFromSettings(settings.customModels),
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

    // Only ask for the model list once the CLI is both present and signed in:
    // `--list-models` reports the entitled set for the signed-in account, and
    // asking an unauthenticated binary risks it blocking on auth during what
    // is supposed to be a health check.
    const discovered =
      probe.status === "ready" ? yield* listKiroModels(binaryPath, environment, cwd) : undefined;
    const models = kiroModelsFromSettings(settings.customModels, discovered);

    yield* Effect.logDebug("kiro.probe", {
      binaryPath,
      installed: probe.installed,
      status: probe.status,
      auth: probe.auth.status,
      // Which catalog the picker is about to show. `fallback` means the live
      // list could not be read, so the models on offer are this build's
      // hardcoded set and may be stale.
      catalog: discovered === undefined ? "fallback" : "live",
      modelCount: models.length,
    });

    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe,
    });
  });
}

/**
 * Read kiro-cli's own model list.
 *
 * Returns `undefined` rather than failing on every unhappy path — a stale
 * catalog is a far better outcome than a provider that reports itself broken
 * because an auxiliary command changed its output.
 */
function listKiroModels(
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Effect.Effect<
  ReadonlyArray<ServerProviderModel> | undefined,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const result = yield* runKiro(binaryPath, ["chat", "--list-models"], environment, cwd).pipe(
      Effect.timeout(MODEL_LIST_PROBE_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(result)) return undefined;
    if (result.success.code !== 0) return undefined;

    const parsed = parseKiroModelList(result.success.stdout);
    // An empty parse means the output shape moved; treat it as unreadable
    // instead of publishing a provider with zero selectable models.
    return parsed.length > 0 ? parsed : undefined;
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
