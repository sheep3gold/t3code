import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";

import { disabledSkillNameSet, withDisabledSkillsFiltered } from "./disabledSkillNames.ts";

const skill = (name: string): ServerProviderSkill => ({
  name,
  path: `/skills/${name}/SKILL.md`,
  enabled: true,
});

const provider: ServerProvider = {
  driver: ProviderDriverKind.make("claudeAgent"),
  instanceId: ProviderInstanceId.make("claude-main"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  checkedAt: "2026-10-19T00:00:00Z",
  auth: { status: "authenticated" },
  models: [],
  slashCommands: [],
  skills: [skill("review"), skill("Release"), skill("deploy")],
  workspaceSnapshots: [
    {
      cwd: "/repo",
      checkedAt: "2026-10-19T00:00:00Z",
      slashCommands: [],
      skills: [skill("release"), skill("repo-only")],
    },
  ],
};

const names = (skills: ReadonlyArray<ServerProviderSkill>) => skills.map((entry) => entry.name);

describe("disabled skills", () => {
  it("drops disabled skills from machine and workspace lists, ignoring case", () => {
    const [filtered] = withDisabledSkillsFiltered([provider], [" RELEASE "]);
    assert.deepStrictEqual(names(filtered!.skills), ["review", "deploy"]);
    assert.deepStrictEqual(names(filtered!.workspaceSnapshots![0]!.skills), ["repo-only"]);
  });

  it("returns the same providers when nothing is disabled", () => {
    const providers = [provider];
    assert.strictEqual(withDisabledSkillsFiltered(providers, []), providers);
    assert.strictEqual(withDisabledSkillsFiltered(providers, undefined), providers);
  });

  it("re-enabling a skill restores it on the next publish", () => {
    const [disabled] = withDisabledSkillsFiltered([provider], ["review"]);
    assert.notInclude(names(disabled!.skills), "review");
    const [restored] = withDisabledSkillsFiltered([provider], []);
    assert.include(names(restored!.skills), "review");
  });

  it("normalizes names from each settings snapshot", () => {
    assert.isTrue(disabledSkillNameSet(["Deploy"]).has("deploy"));
    assert.strictEqual(disabledSkillNameSet([]).size, 0);
  });
});
