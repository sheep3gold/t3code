import { type FactorySettings, ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const DRIVER_KIND = ProviderDriverKind.make("factory");
export const FACTORY_DEFAULT_MODEL_SLUG = "gpt-6-sol";
export const FACTORY_AUTONOMY_CONFIG_ID = "autonomy_level";
type RuntimeSettings = Pick<FactorySettings, "binaryPath">;

/**
 * `droid` advertises two ACP auth methods. The API key one reads
 * `FACTORY_API_KEY`; the device-pairing one needs a browser, which a headless
 * server never has, so it is only the fallback for a machine that is already
 * signed in locally.
 */
export function factoryAuthMethodId(environment: NodeJS.ProcessEnv): string {
  return environment.FACTORY_API_KEY?.trim() ? "factory-api-key" : "device-pairing";
}

/** Maps T3 runtime modes onto droid's `autonomy_level` option values. */
export function factoryAutonomyLevel(runtimeMode?: RuntimeMode): string {
  if (runtimeMode === "full-access") return "auto-high";
  if (runtimeMode === "approval-required") return "normal";
  return "auto-low";
}

export function buildFactoryAcpSpawnInput(
  settings: RuntimeSettings | null | undefined,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.binaryPath?.trim() || "droid",
    args: ["exec", "--input-format", "acp", "-o", "acp"],
    cwd,
    env: { ...environment },
  };
}

interface RuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly factorySettings: RuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeFactoryAcpRuntime = (
  input: RuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const environment = input.environment ?? process.env;
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildFactoryAcpSpawnInput(input.factorySettings, input.cwd, environment),
        authMethodId: factoryAuthMethodId(environment),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });

export function resolveFactoryAcpModelId(model: string | null | undefined): string {
  const base = model?.trim() || FACTORY_DEFAULT_MODEL_SLUG;
  return normalizeModelSlug(base, DRIVER_KIND) ?? FACTORY_DEFAULT_MODEL_SLUG;
}

export function currentFactoryModelIdFromSessionSetup(
  setup:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const option = setup.configOptions?.find((item) => item.id === "model");
  return option && typeof option.currentValue === "string" ? option.currentValue.trim() : undefined;
}
