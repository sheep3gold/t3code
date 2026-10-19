import { describe, expect, it } from "vite-plus/test";

import { extractOptimizedSkill } from "./SkillEditorDialog";

describe("extractOptimizedSkill", () => {
  it("parses a JSON draft with a quoted description and markdown body", () => {
    expect(
      extractOptimizedSkill(
        '{"description":"Check: changes safely","body":"# Review\\n\\n1. Read the diff."}',
      ),
    ).toEqual({
      description: "Check: changes safely",
      body: "# Review\n\n1. Read the diff.",
    });
  });

  it("accepts a fenced JSON draft", () => {
    expect(extractOptimizedSkill('```json\n{"description":"","body":"Instructions"}\n```')).toEqual(
      {
        description: undefined,
        body: "Instructions",
      },
    );
  });

  it("refuses prose and empty instructions", () => {
    expect(extractOptimizedSkill("Here is my answer: {}")).toBeNull();
    expect(extractOptimizedSkill('{"description":"x","body":"   "}')).toBeNull();
  });
});
