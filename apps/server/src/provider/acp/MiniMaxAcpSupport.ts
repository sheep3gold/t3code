import { type MiniMaxSettings, ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const DRIVER_KIND = ProviderDriverKind.make("minimax");
const AUTH_METHOD = "cached_token";
export const MINIMAX_DEFAULT_MODEL_SLUG =
  "m:custom_provider%3Aminimax-official-api:MiniMax-M3:v:thinking";
type RuntimeSettings = Pick<MiniMaxSettings, "binaryPath" | "dataDir">;

export function miniMaxProcessEnvironment(
  settings: RuntimeSettings | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const dataDir = settings?.dataDir?.trim();
  return dataDir ? { ...environment, MINIMAX_DATA_DIR: dataDir } : { ...environment };
}
export function miniMaxPermissionMode(runtimeMode?: RuntimeMode): string {
  if (runtimeMode === "full-access") return "bypassPermissions";
  if (runtimeMode === "approval-required") return "default";
  return "auto";
}
export function buildMiniMaxAcpSpawnInput(
  settings: RuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.binaryPath?.trim() || "mcode",
    args: ["acp"],
    cwd,
    env: miniMaxProcessEnvironment(settings, environment),
  };
}
interface RuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly minimaxSettings: RuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}
export const makeMiniMaxAcpRuntime = (
  input: RuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildMiniMaxAcpSpawnInput(input.minimaxSettings, input.cwd, input.environment),
        authMethodId: AUTH_METHOD,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });
export function resolveMiniMaxAcpModelId(model: string | null | undefined): string {
  const base = model?.trim() || MINIMAX_DEFAULT_MODEL_SLUG;
  return normalizeModelSlug(base, DRIVER_KIND) ?? MINIMAX_DEFAULT_MODEL_SLUG;
}
export function currentMiniMaxModelIdFromSessionSetup(
  setup:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const option = setup.configOptions?.find((item) => item.id === "model");
  return option && typeof option.currentValue === "string" ? option.currentValue.trim() : undefined;
}
export function miniMaxExecModel(model: string | null | undefined): string {
  const match = /^m:([^:]+):([^:]+)(?::|$)/.exec(resolveMiniMaxAcpModelId(model));
  if (!match?.[1] || !match[2]) return "custom_provider:minimax-official-api/MiniMax-M3";
  try {
    return `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
  } catch {
    return "custom_provider:minimax-official-api/MiniMax-M3";
  }
}
