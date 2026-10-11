import type { ProviderInstanceId, ServerProvider, ServerProviderSkill } from "@t3tools/contracts";

export interface SkillRow {
  readonly name: string;
  readonly description: string | undefined;
  readonly providerLabels: ReadonlyArray<string>;
  readonly editableInstanceId: ProviderInstanceId | undefined;
}

/** A merged name is editable only if every discovery points to the same Claude user file. */
export function collectSkillRows(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<SkillRow> {
  const rows = new Map<
    string,
    {
      name: string;
      description: string | undefined;
      labels: Set<string>;
      sources: Set<string>;
      hasReadOnlySource: boolean;
      instanceId: ProviderInstanceId | undefined;
    }
  >();
  for (const provider of providers) {
    if (!provider.enabled) continue;
    const providerLabel = provider.displayName ?? provider.instanceId;
    const discovered: ReadonlyArray<ServerProviderSkill> = [
      ...provider.skills,
      ...(provider.workspaceSnapshots ?? []).flatMap((snapshot) => snapshot.skills),
    ];
    for (const skill of discovered) {
      const key = skill.name.trim().toLowerCase();
      if (!key) continue;
      const path = skill.path?.replaceAll("\\", "/");
      const isClaudeUserScope =
        provider.driver === "claudeAgent" &&
        skill.scope === "user" &&
        path?.endsWith(`/${skill.name}/SKILL.md`) === true;
      const row = rows.get(key) ?? {
        name: skill.name,
        description: skill.description ?? skill.shortDescription,
        labels: new Set<string>(),
        sources: new Set<string>(),
        hasReadOnlySource: false,
        instanceId: undefined,
      };
      row.labels.add(providerLabel);
      row.sources.add(`${provider.instanceId}\u0000${path ?? ""}`);
      if (!isClaudeUserScope) row.hasReadOnlySource = true;
      else row.instanceId = provider.instanceId;
      rows.set(key, row);
    }
  }
  return [...rows.values()]
    .map((row) => ({
      name: row.name,
      description: row.description,
      providerLabels: [...row.labels],
      editableInstanceId:
        !row.hasReadOnlySource && row.sources.size === 1 ? row.instanceId : undefined,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Case-insensitive substring match over the displayed name and description. */
export function filterSkillRows<T extends Pick<SkillRow, "name" | "description">>(
  rows: ReadonlyArray<T>,
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter(
    (row) =>
      row.name.toLowerCase().includes(needle) ||
      (row.description?.toLowerCase().includes(needle) ?? false),
  );
}
