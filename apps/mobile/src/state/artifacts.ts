import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentArtifactAtoms } from "@t3tools/client-runtime/state/artifacts";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";

const artifactEnvironment = createEnvironmentArtifactAtoms(connectionAtomRuntime);

function formatError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Artifacts could not be loaded.";
}

export function useArtifacts(environmentId: EnvironmentId, projectId: ProjectId) {
  const atom = artifactEnvironment.list({ environmentId, input: { projectId } });
  const result = useAtomValue(atom);
  const value = Option.getOrNull(AsyncResult.value(result));
  return {
    artifacts: value?.artifacts ?? [],
    error: result._tag === "Failure" ? formatError(result.cause) : null,
    isPending: result.waiting,
    refresh: useCallback(() => appAtomRegistry.refresh(atom), [atom]),
  };
}

export function useArtifact(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  slug: string,
  version?: number,
) {
  const detailAtom = artifactEnvironment.detail({
    environmentId,
    input: { projectId, slug, ...(version === undefined ? {} : { version }) },
  });
  const versionsAtom = artifactEnvironment.versions({
    environmentId,
    input: { projectId, slug },
  });
  const detailResult = useAtomValue(detailAtom);
  const versionsResult = useAtomValue(versionsAtom);
  const detail = Option.getOrNull(AsyncResult.value(detailResult));
  const versions = Option.getOrNull(AsyncResult.value(versionsResult));
  return {
    detail,
    versions: versions?.versions ?? [],
    error:
      detailResult._tag === "Failure"
        ? formatError(detailResult.cause)
        : versionsResult._tag === "Failure"
          ? formatError(versionsResult.cause)
          : null,
    isPending: detailResult.waiting || versionsResult.waiting,
  };
}
