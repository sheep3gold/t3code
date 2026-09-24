/**
 * KiroAcpSupport — the Kiro-specific bits the generic ACP layer cannot know.
 *
 * kiro-cli speaks ACP through its `acp` subcommand. Two things differ from the
 * other ACP CLIs and are the reason this file exists:
 *
 *   * **The engine must be pinned.** kiro-cli 2.21 still defaults to the v1
 *     engine, which cannot speak ACP at all — it answers
 *     "--output-format stream-json is not supported on the v1 engine. Pass
 *     --agent-engine v2 (or v3)." and exits. Passing `--agent-engine`
 *     explicitly makes one setting work across 2.21 and 2.23+ instead of
 *     silently failing on the older binary.
 *
 *   * **Permission modes map onto tool trust, not a permission flag.**
 *     kiro-cli has no `--permission-mode`; it has `--trust-all-tools` and
 *     `--trust-tools=<list>` (empty list = trust nothing). So T3's runtime
 *     modes are expressed by how much tool trust the process starts with, and
 *     everything not pre-trusted comes back through ACP as a permission
 *     request that T3 asks the user about.
 *
 * @module provider/acp/KiroAcpSupport
 */
import { type KiroSettings, ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const KIRO_DRIVER_KIND = ProviderDriverKind.make("kiro");

/**
 * kiro-cli authenticates itself through `kiro-cli login` (IAM Identity Center
 * device flow) and keeps its own cached token, so there is no credential for
 * T3 to hand over — the ACP handshake just names the method it used.
 */
const KIRO_AUTH_METHOD_CACHED_TOKEN = "cached_token";

/** Thread default. Deliberately the strongest model rather than the cheapest. */
export const KIRO_DEFAULT_MODEL_SLUG = "claude-opus-5";

type KiroAcpRuntimeSettings = Pick<KiroSettings, "binaryPath" | "agentEngine" | "agent">;

interface KiroAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kiroSettings: KiroAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

/**
 * Build the argv for `kiro-cli acp`.
 *
 * The runtime-mode mapping is the security boundary of this provider, so it is
 * spelled out rather than collapsed:
 *
 *   * `approval-required` starts with **no** trusted tools, so every read,
 *     write and command comes back as an ACP permission request.
 *   * `auto-accept-edits` pre-trusts reads and writes but not execution —
 *     `execute_bash` still asks. Trusting it here would make "auto-accept
 *     edits" silently mean "run anything".
 *   * `auto` pre-trusts reads only; writes and commands ask. kiro-cli has no
 *     model-driven automatic review, so this is the honest reading of "approve
 *     routine actions".
 *   * `full-access` uses `--trust-all-tools`.
 *
 * `--trust-tools=` with an empty value is kiro-cli's documented way to trust
 * nothing; it is not the same as omitting the flag, which would fall back to
 * the CLI's own defaults.
 */
export function kiroAcpSpawnArgs(
  settings: KiroAcpRuntimeSettings | null | undefined,
  runtimeMode?: RuntimeMode,
): ReadonlyArray<string> {
  const args: string[] = ["acp", "--agent-engine", settings?.agentEngine ?? "v2"];

  const agent = settings?.agent?.trim();
  if (agent) {
    args.push("--agent", agent);
  }

  switch (runtimeMode) {
    case "full-access":
      args.push("--trust-all-tools");
      break;
    case "auto-accept-edits":
      args.push("--trust-tools=fs_read,fs_write");
      break;
    case "auto":
      args.push("--trust-tools=fs_read");
      break;
    case "approval-required":
    default:
      args.push("--trust-tools=");
      break;
  }

  return args;
}

export function buildKiroAcpSpawnInput(
  settings: KiroAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.binaryPath || "kiro-cli",
    args: [...kiroAcpSpawnArgs(settings, runtimeMode)],
    cwd,
    env: { ...environment },
  };
}

export const makeKiroAcpRuntime = (
  input: KiroAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKiroAcpSpawnInput(
          input.kiroSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        authMethodId: KIRO_AUTH_METHOD_CACHED_TOKEN,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    // Unlike Grok (which wraps the runtime in an xAI prompt-completion shim),
    // kiro-cli needs no protocol extension: its `acp` output is already
    // `payloadSchema: "acp"` at `acpProtocolVersion: 1`.
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * Resolve the model id to send over ACP.
 *
 * kiro-cli's slugs keep their dots (`claude-haiku-4.5`, `deepseek-3.2`,
 * `gpt-5.6-sol`) where T3's Claude catalog uses dashes. `normalizeModelSlug`
 * is per-driver, so it must not rewrite these — if it ever returns null we
 * fall back to the default rather than sending a mangled id that kiro-cli
 * would reject.
 */
export function resolveKiroAcpModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : KIRO_DEFAULT_MODEL_SLUG;
  return normalizeModelSlug(base, KIRO_DRIVER_KIND) ?? KIRO_DEFAULT_MODEL_SLUG;
}
