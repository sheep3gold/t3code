import { describe, expect, it } from "vite-plus/test";

import { Schema } from "effect";
import {
  IsoDateTime,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderSkill,
  type ServerProvider,
  type ServerProviderWorkspaceSnapshot,
} from "@t3tools/contracts";

import {
  disabledSkillNameSet,
  filterDisabledSkills,
  filterProviderDisabledSkills,
} from "./sharedSkills.ts";

const decodeSkill = Schema.decodeUnknownSync(ServerProviderSkill);

const makeSkill = (name: string) =>
  decodeSkill({ name, path: `/skills/${name}/SKILL.md`, enabled: true });

function makeProvider(overrides: {
  readonly skills: ReadonlyArray<string>;
  readonly workspaceSnapshots?: ReadonlyArray<ServerProviderWorkspaceSnapshot>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
    models: [],
    slashCommands: [],
    skills: overrides.skills.map(makeSkill),
    ...(overrides.workspaceSnapshots === undefined
      ? {}
      : { workspaceSnapshots: overrides.workspaceSnapshots }),
  };
}

describe("filterDisabledSkills", () => {
  it("removes disabled skills case-insensitively", () => {
    const skills = [
      { name: "Review", path: "/a/SKILL.md", enabled: true },
      { name: "release", path: "/b/SKILL.md", enabled: true },
    ];

    expect(filterDisabledSkills(skills, new Set(["review"]))).toEqual([skills[1]]);
  });

  it("returns every skill when nothing is disabled", () => {
    const skills = [{ name: "review", path: "/a/SKILL.md", enabled: true }];

    expect(filterDisabledSkills(skills, new Set())).toEqual(skills);
  });
});

describe("disabledSkillNameSet", () => {
  it("normalizes case and whitespace and drops empties", () => {
    expect(disabledSkillNameSet([" Review ", "RELEASE", "  "])).toEqual(
      new Set(["review", "release"]),
    );
  });
});

describe("filterProviderDisabledSkills", () => {
  it("filters machine-level and workspace snapshot skills", () => {
    const provider = makeProvider({
      skills: ["review", "release"],
      workspaceSnapshots: [
        {
          cwd: "/repo" as ServerProviderWorkspaceSnapshot["cwd"],
          checkedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
          slashCommands: [],
          skills: [makeSkill("review"), makeSkill("docs")],
        },
      ],
    });

    const filtered = filterProviderDisabledSkills(provider, new Set(["REVIEW"]));

    expect(filtered.skills.map((skill) => skill.name)).toEqual(["release"]);
    expect(filtered.workspaceSnapshots?.[0]?.skills.map((skill) => skill.name)).toEqual(["docs"]);
  });

  it("returns the provider untouched when nothing is disabled", () => {
    const provider = makeProvider({ skills: ["review"] });

    expect(filterProviderDisabledSkills(provider, new Set())).toBe(provider);
  });
});
