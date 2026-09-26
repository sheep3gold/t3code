import {
  THREAD_RETRY_PROMPT,
  type OrchestrationSession,
} from "@t3tools/contracts";

export { THREAD_RETRY_PROMPT };

export function canRetryThread(input: {
  readonly session: Pick<OrchestrationSession, "status" | "activeTurnId" | "lastError"> | null;
  readonly hasUserMessage: boolean;
  readonly hasPendingRequest?: boolean;
}): boolean {
  if (!input.hasUserMessage || input.hasPendingRequest === true) return false;
  const session = input.session;
  if (!session || session.activeTurnId !== null) return false;
  return (
    session.status === "error" ||
    session.status === "interrupted" ||
    (session.status === "stopped" && session.lastError !== null)
  );
}
