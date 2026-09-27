import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentMemoryLedgerAtoms } from "@t3tools/client-runtime/state/memory-ledger";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const memoryLedgerEnvironment = createEnvironmentMemoryLedgerAtoms(connectionAtomRuntime);

function message(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Data could not be loaded.";
}

export function useMemories(environmentId: EnvironmentId, projectId: ProjectId) {
  const atom = memoryLedgerEnvironment.memories({ environmentId, input: { projectId } });
  const result = useAtomValue(atom);
  const value = Option.getOrNull(AsyncResult.value(result));
  return {
    memories: value?.memories ?? [],
    error: result._tag === "Failure" ? message(result.cause) : null,
    isPending: result.waiting,
    refresh: useCallback(() => appAtomRegistry.refresh(atom), [atom]),
  };
}

export function useLedger(environmentId: EnvironmentId, projectId: ProjectId, threadId: ThreadId) {
  const atom = memoryLedgerEnvironment.ledger({
    environmentId,
    input: { projectId, threadId },
  });
  const result = useAtomValue(atom);
  const value = Option.getOrNull(AsyncResult.value(result));
  return {
    snapshot: value,
    error: result._tag === "Failure" ? message(result.cause) : null,
    isPending: result.waiting,
    refresh: useCallback(() => appAtomRegistry.refresh(atom), [atom]),
  };
}
