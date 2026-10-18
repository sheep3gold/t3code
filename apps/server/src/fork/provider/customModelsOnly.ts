import type { ProviderInstanceEnvironment, ServerProvider } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * An instance pointed at an Anthropic- or OpenAI-compatible gateway (GLM,
 * Kimi, Grok, WorkBuddy...) can only serve the models configured on it, so the
 * built-in catalog would offer models that always fail. These flags hide it.
 */
const CUSTOM_MODELS_ONLY_FLAGS = ["T3_CLAUDE_CUSTOM_MODELS_ONLY", "T3_CODEX_CUSTOM_MODELS_ONLY"];
const TRUTHY = /^(?:1|true|yes|on)$/i;

export function wantsCustomModelsOnly(environment: ProviderInstanceEnvironment): boolean {
  return environment.some(
    (variable) =>
      CUSTOM_MODELS_ONLY_FLAGS.includes(variable.name) && TRUTHY.test(variable.value.trim()),
  );
}

export function keepCustomModels(snapshot: ServerProvider): ServerProvider {
  const custom = snapshot.models.filter((model) => model.isCustom);
  if (custom.length === 0) return snapshot;
  return {
    ...snapshot,
    models: custom.map((model, index) => ({ ...model, isDefault: index === 0 })),
  };
}

export function withCustomModelsOnly(
  instance: ProviderInstance,
  environment: ProviderInstanceEnvironment,
): ProviderInstance {
  if (!wantsCustomModelsOnly(environment)) return instance;
  const snapshot = instance.snapshot;
  return {
    ...instance,
    snapshot: {
      ...snapshot,
      getSnapshot: Effect.map(snapshot.getSnapshot, keepCustomModels),
      refresh: Effect.map(snapshot.refresh, keepCustomModels),
      streamChanges: Stream.map(snapshot.streamChanges, keepCustomModels),
    },
  };
}
