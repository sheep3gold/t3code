import type { EnvironmentArtifactKind, EnvironmentArtifactSummary } from "@t3tools/contracts";

export type ArtifactKindFilter = EnvironmentArtifactKind | "all";

export function filterArtifacts(
  artifacts: ReadonlyArray<EnvironmentArtifactSummary>,
  query: string,
  kind: ArtifactKindFilter,
): ReadonlyArray<EnvironmentArtifactSummary> {
  const normalized = query.trim().toLowerCase();
  return artifacts.filter(
    (artifact) =>
      (kind === "all" || artifact.kind === kind) &&
      (normalized.length === 0 ||
        artifact.name.toLowerCase().includes(normalized) ||
        artifact.slug.toLowerCase().includes(normalized) ||
        artifact.tags.some((tag) => tag.toLowerCase().includes(normalized))),
  );
}
