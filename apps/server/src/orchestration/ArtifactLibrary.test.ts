import { describe, expect, it } from "vite-plus/test";

import { artifactSlug } from "./ArtifactLibrary.ts";

describe("ArtifactLibrary", () => {
  it("creates readable collision-resistant slugs", () => {
    expect(artifactSlug("Release Notes v2", "ABCDEF123456")).toBe(
      "release-notes-v2-abcdef12",
    );
    expect(artifactSlug("中文报告", "1234567890")).toBe("artifact-12345678");
  });
});
