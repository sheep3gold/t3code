import type { ServerProvider, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverCursorSkills } from "./Drivers/CursorSkills.ts";

export function mergeProviderSkills(
  nativeSkills: ReadonlyArray<ServerProviderSkill>,
  sharedSkills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSkill[] {
  const nativeNames = new Set(nativeSkills.map((skill) => skill.name.trim().toLowerCase()));
  const sharedByName = new Map(
    sharedSkills
      .filter((skill) => !nativeNames.has(skill.name.trim().toLowerCase()))
      .map((skill) => [skill.name.trim().toLowerCase(), skill] as const),
  );

  return [...nativeSkills, ...sharedByName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export function providerSkillsForCwd(
  provider: ServerProvider,
  cwd: string | undefined,
): ReadonlyArray<ServerProviderSkill> {
  if (!cwd) return provider.skills;
  return (
    provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd)?.skills ?? provider.skills
  );
}

/**
 * Removes skills the user disabled in Settings. Disabled skills are dropped
 * from the snapshot entirely (rather than flagged) so every consumer — the
 * `$` menu, the dispatch rewrite, third-party clients — sees the same list.
 */
export function filterDisabledSkills(
  skills: ReadonlyArray<ServerProviderSkill>,
  disabledSkillNames: ReadonlySet<string>,
): ServerProviderSkill[] {
  if (disabledSkillNames.size === 0) return [...skills];
  // Written as `=== false` instead of a `!` prefix: this file ships in the
  // CLI bundle, which Node runs with type stripping, and a leading `!` parses
  // as a non-null assertion there.
  return skills.filter(
    (skill) => disabledSkillNames.has(skill.name.trim().toLowerCase()) === false,
  );
}

/** Normalizes the persisted setting into the lookup set used above. */
export function disabledSkillNameSet(disabledSkills: ReadonlyArray<string>): ReadonlySet<string> {
  return new Set(disabledSkills.map((name) => name.trim().toLowerCase()).filter(Boolean));
}

/**
 * Drops disabled skills from a provider snapshot and every cached workspace
 * snapshot on it. Applied centrally so machine-level and cwd-scoped lists
 * agree no matter which driver discovered them.
 */
export function filterProviderDisabledSkills(
  provider: ServerProvider,
  disabledSkillNames: ReadonlySet<string>,
): ServerProvider {
  if (disabledSkillNames.size === 0) return provider;
  return {
    ...provider,
    skills: filterDisabledSkills(provider.skills, disabledSkillNames),
    ...(provider.workspaceSnapshots === undefined
      ? {}
      : {
          workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
            ...snapshot,
            skills: filterDisabledSkills(snapshot.skills, disabledSkillNames),
          })),
        }),
  };
}

export const discoverSharedProviderSkills = Effect.fn("discoverSharedProviderSkills")(function* (
  cwd: string,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  return yield* discoverCursorSkills(cwd);
});

export function providerSkillNames(
  skills: ReadonlyArray<ServerProviderSkill>,
): ReadonlySet<string> {
  return new Set(
    skills
      .filter((skill) => skill.enabled && skill.userInvocable !== false)
      .map((skill) => skill.name),
  );
}
