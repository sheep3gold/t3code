import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentWorkflowAtoms } from "@t3tools/client-runtime/state/workflows";
import type { EnvironmentId, EnvironmentThreadWorkflow, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const workflowEnvironment = createEnvironmentWorkflowAtoms(connectionAtomRuntime);

function formatWorkflowError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Workflows could not be loaded.";
}

export function useWorkflows(environmentId: EnvironmentId, projectId: ProjectId) {
  const atom = workflowEnvironment.list({ environmentId, input: { projectId } });
  const result = useAtomValue(atom);
  const value = Option.getOrNull(AsyncResult.value(result));
  const refresh = useCallback(() => appAtomRegistry.refresh(atom), [atom]);

  return {
    workflows: (value?.workflows ?? []) as ReadonlyArray<EnvironmentThreadWorkflow>,
    error: result._tag === "Failure" ? formatWorkflowError(result.cause) : null,
    isPending: result.waiting,
    refresh,
  };
}
