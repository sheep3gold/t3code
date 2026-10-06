import { type ServerProvider, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectSkillRows, filterSkillRows } from "./skillsFilter";

const rows = [
  { name: "review-diff", description: "Review the current diff." },
  { name: "commit", description: "Write a commit message." },
  { name: "Release Notes", description: undefined },
] as const;

const discovered = {
  name: "review-diff",
  description: "Review the diff",
  scope: "user",
  path: "/config/skills/review-diff/SKILL.md",
  enabled: true,
} as const;
const provider = (
  driver: "claudeAgent" | "codex",
  id: string,
  skill: ServerProvider["skills"][number],
): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    skills: [skill],
  }) as unknown as ServerProvider;

describe("collectSkillRows", () => {
  it("edits only a uniquely sourced Claude user skill", () => {
    const claude = provider("claudeAgent", "claude-default", discovered);
    expect(collectSkillRows([claude])[0]?.editableInstanceId).toBe(claude.instanceId);
    expect(
      collectSkillRows([claude, provider("codex", "codex-default", discovered)])[0]
        ?.editableInstanceId,
    ).toBeUndefined();
    expect(
      collectSkillRows([claude, provider("claudeAgent", "claude-other", discovered)])[0]
        ?.editableInstanceId,
    ).toBeUndefined();
  });

  it("never edits a project-scope, pathless, or ambiguous copy", () => {
    for (const skill of [
      { ...discovered, scope: "project" },
      {
        name: discovered.name,
        description: discovered.description,
        scope: "user",
        path: "",
        enabled: true,
      },
      { ...discovered, path: "/other/skills/review-diff/SKILL.md" },
    ]) {
      const existing = provider("claudeAgent", "claude-default", discovered);
      const other = provider("claudeAgent", "claude-default", skill);
      const rows = collectSkillRows([
        {
          ...existing,
          workspaceSnapshots: [
            {
              cwd: "/project",
              checkedAt: new Date().toISOString(),
              slashCommands: [],
              skills: [other.skills[0]!],
            },
          ],
        },
      ]);
      expect(rows[0]?.editableInstanceId).toBeUndefined();
    }
  });
});

describe("filterSkillRows", () => {
  it("keeps every row for a blank query", () => {
    expect(filterSkillRows(rows, "")).toHaveLength(3);
    expect(filterSkillRows(rows, "   ")).toHaveLength(3);
  });

  it("matches by name case-insensitively", () => {
    expect(filterSkillRows(rows, "REVIEW").map((row) => row.name)).toEqual(["review-diff"]);
    expect(filterSkillRows(rows, "release").map((row) => row.name)).toEqual(["Release Notes"]);
  });

  it("matches by description", () => {
    expect(filterSkillRows(rows, "commit message").map((row) => row.name)).toEqual(["commit"]);
  });

  it("returns no rows when nothing matches", () => {
    expect(filterSkillRows(rows, "nonexistent")).toEqual([]);
  });
});
