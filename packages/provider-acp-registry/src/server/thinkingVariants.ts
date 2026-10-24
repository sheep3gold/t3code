import type { AcpRegistryProbeModel, ProviderOptionSelection } from "@t3tools/contracts";

/**
 * Kimi CLI has no thinking config option over ACP. It doubles every model in
 * the session `models` state instead (`k3` and `k3,thinking`). T3 shows one
 * model with a synthetic Thinking toggle and picks the variant at session open.
 */
export const ACP_THINKING_OPTION_ID = "_t3/thinking";

const THINKING_SUFFIX = ",thinking";
const THINKING_NAME_SUFFIX = / \(thinking\)$/u;

// Kimi still lists a non-thinking variant for these, but its API rejects every
// request with "does not support disabled thinking mode".
const THINKING_REQUIRED = /^kimi-code\/k3\.1-pro(?:-highspeed)?$/u;

export type ThinkingSupport = "none" | "toggle" | "always";

export interface CollapsedAcpModel {
  readonly id: string;
  readonly name: string;
  readonly thinking: ThinkingSupport;
}

const baseId = (id: string): string | undefined =>
  id.endsWith(THINKING_SUFFIX) ? id.slice(0, -THINKING_SUFFIX.length) : undefined;

export function collapseThinkingVariants(
  models: ReadonlyArray<AcpRegistryProbeModel>,
): ReadonlyArray<CollapsedAcpModel> {
  const ids = new Set(models.map((model) => model.id));
  const collapsed = new Map<string, CollapsedAcpModel>();
  for (const model of models) {
    const base = baseId(model.id);
    if (base === undefined) {
      if (collapsed.has(model.id)) continue;
      const thinking: ThinkingSupport = !ids.has(model.id + THINKING_SUFFIX)
        ? "none"
        : THINKING_REQUIRED.test(model.id)
          ? "always"
          : "toggle";
      collapsed.set(model.id, { id: model.id, name: model.name, thinking });
      continue;
    }
    if (ids.has(base)) continue;
    collapsed.set(base, {
      id: base,
      name: model.name.replace(THINKING_NAME_SUFFIX, "") || base,
      thinking: "always",
    });
  }
  return [...collapsed.values()];
}

/** Maps a reported variant id (`k3,thinking`) to the collapsed model slug. */
export function collapsedModelId(id: string): string {
  return baseId(id) ?? id;
}

/** Resolves a collapsed selection back to the variant id the agent listed. */
export function resolveThinkingVariant(
  requested: string,
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
  availableIds: ReadonlySet<string>,
): string {
  const thinkingId = requested + THINKING_SUFFIX;
  if (baseId(requested) !== undefined || !availableIds.has(thinkingId)) return requested;
  if (!availableIds.has(requested) || THINKING_REQUIRED.test(requested)) return thinkingId;
  const enabled = options?.find((option) => option.id === ACP_THINKING_OPTION_ID)?.value;
  return enabled === false ? requested : thinkingId;
}
