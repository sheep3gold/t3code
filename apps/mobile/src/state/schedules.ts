import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentScheduleAtoms } from "@t3tools/client-runtime/state/schedules";
import type { EnvironmentId, EnvironmentThreadSchedule, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";

export const scheduleEnvironment = createEnvironmentScheduleAtoms(connectionAtomRuntime);

function formatScheduleError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Schedules could not be loaded.";
}

export function useSchedules(environmentId: EnvironmentId, projectId: ProjectId) {
  const atom = scheduleEnvironment.list({ environmentId, input: { projectId } });
  const result = useAtomValue(atom);
  const value = Option.getOrNull(AsyncResult.value(result));
  const refresh = useCallback(() => appAtomRegistry.refresh(atom), [atom]);
  return {
    schedules: (value?.schedules ?? []) as ReadonlyArray<EnvironmentThreadSchedule>,
    error: result._tag === "Failure" ? formatScheduleError(result.cause) : null,
    isPending: result.waiting,
    refresh,
  };
}
