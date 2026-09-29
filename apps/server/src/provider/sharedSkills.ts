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
