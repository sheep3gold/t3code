import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

export const MAX_AUTO_RETRY_ATTEMPTS = 3;

export const AUTO_RETRY_PROGRESS_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
] as const satisfies ReadonlyArray<OrchestrationV2TurnItem["type"]>;

/** Only failures that can plausibly succeed on a second try. */
export function isTransientFailure(failure: OrchestrationV2ProviderFailure | null): boolean {
  if (failure === null || failure.retryable === false) return false;
  if (failure.class === "usage_limit") return false;
  if (failure.class === "permission_error" || failure.class === "validation_error") return false;
  if (failure.retryable === true) return true;
  if (failure.class === "transport_error") return true;
  // An uncoded provider error is usually a local guard, not an API failure.
  return failure.class === "provider_error" && failure.code !== null;
}

/** Persisted progress breaks a failure streak, including across server restarts. */
export function retryLineage(
  run: Pick<OrchestrationV2Run, "id" | "userMessageId">,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): {
  readonly originRunId: string;
  readonly attempt: number;
} {
  const match = /^auto-retry:(\d+):(.+)$/.exec(run.userMessageId);
  // A preamble, reasoning or a checkpoint is not evidence that the retry worked.
  const recovered =
    match !== null &&
    turnItems.some(
      (item) =>
        item.runId === run.id &&
        item.status === "completed" &&
        item.toolNonExecutionKind === undefined &&
        AUTO_RETRY_PROGRESS_ITEM_TYPES.some((type) => type === item.type) &&
        (item.type !== "command_execution" ||
          ((item.exitCode === undefined || item.exitCode === 0) &&
            item.outputIndicatesFailure !== true)),
    );
  return match !== null && !recovered
    ? { originRunId: match[2]!, attempt: Number(match[1]) }
    : { originRunId: run.id, attempt: 0 };
}

export function canAutoRetry(
  run: OrchestrationV2Run,
  failure: OrchestrationV2ProviderFailure | null,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): boolean {
  return (
    run.status === "failed" &&
    isTransientFailure(failure) &&
    retryLineage(run, turnItems).attempt < MAX_AUTO_RETRY_ATTEMPTS
  );
}
