import type { OrchestrationV2ProviderFailure, OrchestrationV2Run } from "@t3tools/contracts";

export const MAX_AUTO_RETRY_ATTEMPTS = 3;

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

/** Message IDs preserve the retry cap across server restarts. */
export function retryLineage(run: Pick<OrchestrationV2Run, "id" | "userMessageId">): {
  readonly originRunId: string;
  readonly attempt: number;
} {
  const match = /^auto-retry:(\d+):(.+)$/.exec(run.userMessageId);
  return match
    ? { originRunId: match[2]!, attempt: Number(match[1]) }
    : { originRunId: run.id, attempt: 0 };
}

export function canAutoRetry(
  run: OrchestrationV2Run,
  failure: OrchestrationV2ProviderFailure | null,
  previousRun?: OrchestrationV2Run,
): boolean {
  const lineage = retryLineage(run);
  // Reset the counter if the previous run succeeded: the cap only guards
  // against consecutive invalid retries, not permanent consumption by a chain
  // that recovered.
  const attempt = previousRun?.status === "completed" ? 0 : lineage.attempt;
  return (
    run.status === "failed" && isTransientFailure(failure) && attempt < MAX_AUTO_RETRY_ATTEMPTS
  );
}
