import type { ServerProvider, ServerProviderSkill } from "@t3tools/contracts";

/**
 * Skills the user turned off in Settings → Skills. Matching is by name,
 * case-insensitive, and global across provider instances: a disabled skill is
 * dropped from every provider snapshot the server publishes, so the `$` menu
 * stops offering it, and the Claude adapter leaves a hand-typed `$name` as
 * literal text instead of dispatching it.
 */
export function disabledSkillNameSet(disabledSkills: ReadonlyArray<string>): ReadonlySet<string> {
  return new Set(disabledSkills.map((name) => name.trim().toLowerCase()).filter(Boolean));
}

export function isSkillNameDisabled(name: string, disabled: ReadonlySet<string>): boolean {
  return disabled.has(name.trim().toLowerCase());
}

function filterSkills(
  skills: ReadonlyArray<ServerProviderSkill>,
  disabled: ReadonlySet<string>,
): ReadonlyArray<ServerProviderSkill> {
  return skills.filter((skill) => isSkillNameDisabled(skill.name, disabled) === false);
}

/** Drops disabled skills from the machine-level list and every cached workspace list. */
export function filterProviderDisabledSkills(
  provider: ServerProvider,
  disabled: ReadonlySet<string>,
): ServerProvider {
  if (disabled.size === 0) return provider;
  return {
    ...provider,
    skills: filterSkills(provider.skills, disabled),
    ...(provider.workspaceSnapshots === undefined
      ? {}
      : {
          workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
            ...snapshot,
            skills: filterSkills(snapshot.skills, disabled),
          })),
        }),
  };
}

export function withDisabledSkillsFiltered(
  providers: ReadonlyArray<ServerProvider>,
  disabledSkills: ReadonlyArray<string> | undefined,
): ReadonlyArray<ServerProvider> {
  const disabled = disabledSkillNameSet(disabledSkills ?? []);
  if (disabled.size === 0) return providers;
  return providers.map((provider) => filterProviderDisabledSkills(provider, disabled));
}
