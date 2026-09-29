import { createFileRoute } from "@tanstack/react-router";

import { ArtifactLibraryPage } from "../components/artifacts/ArtifactLibraryPage";

export const Route = createFileRoute("/artifacts")({
  component: ArtifactLibraryPage,
});
