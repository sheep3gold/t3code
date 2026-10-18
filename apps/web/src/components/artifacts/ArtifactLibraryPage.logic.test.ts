import type { EnvironmentArtifactSummary } from "@t3tools/contracts";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterArtifacts } from "./ArtifactLibraryPage.logic";

const BASE: EnvironmentArtifactSummary = {
  id: "artifact-1",
  slug: "release-notes",
  projectId: ProjectId.make("project-1"),
  name: "Release notes",
  kind: "markdown",
  description: "What changed",
  tags: ["shipping", "docs"],
  currentVersion: 3,
  sourceThreadId: ThreadId.make("thread-1"),
  createdAt: "2026-09-26T12:00:00.000Z",
  updatedAt: "2026-09-26T13:00:00.000Z",
};

const JSON_ARTIFACT: EnvironmentArtifactSummary = {
  ...BASE,
  id: "artifact-2",
  slug: "api-schema",
  name: "API schema",
  kind: "json",
  tags: ["contracts"],
};

const ARTIFACTS = [BASE, JSON_ARTIFACT];

describe("filterArtifacts", () => {
  it("matches names, slugs and tags without case sensitivity", () => {
    expect(filterArtifacts(ARTIFACTS, "RELEASE", "all")).toEqual([BASE]);
    expect(filterArtifacts(ARTIFACTS, "api-schema", "all")).toEqual([JSON_ARTIFACT]);
    expect(filterArtifacts(ARTIFACTS, "shipping", "all")).toEqual([BASE]);
  });

  it("combines kind filtering with text search", () => {
    expect(filterArtifacts(ARTIFACTS, "", "json")).toEqual([JSON_ARTIFACT]);
    expect(filterArtifacts(ARTIFACTS, "schema", "markdown")).toEqual([]);
  });

  it("treats surrounding whitespace as an empty query", () => {
    expect(filterArtifacts(ARTIFACTS, "   ", "all")).toEqual(ARTIFACTS);
  });
});
