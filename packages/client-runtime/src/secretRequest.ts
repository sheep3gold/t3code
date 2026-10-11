import {
  ApprovalRequestId,
  type OrchestrationThreadActivity,
  type SecretRequestAnswerInput,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/** Shown under the field: the one promise the card makes about the value. */
export const SECRET_REQUEST_PRIVACY_NOTE = "Stored securely, never shown to the agent";
export const SECRET_REQUEST_DEFAULT_PLACEHOLDER = "Paste the secret";

const isRequestId = Schema.is(ApprovalRequestId);

/**
 * The card the server records for a secret request: an async user-input
 * activity flagged `secretRequest`, so ordinary question panels skip it and
 * the value field renders masked with its own answer RPC.
 */
export interface SecretRequestCard {
  readonly requestId: ApprovalRequestId;
  readonly threadId: import("@t3tools/contracts").ThreadId;
  readonly createdAt: string;
  readonly label: string;
  readonly reason: string;
  readonly placeholder?: string;
}

/** What a secret request card shows: the form while pending, otherwise a one-line outcome. */
export type SecretRequestDisplay =
  | { readonly kind: "pending" }
  | { readonly kind: "answered"; readonly outcome: "saved" | "declined" | "ended" };

const activityPayload = (activity: OrchestrationThreadActivity) =>
  Predicate.isObject(activity.payload) ? activity.payload : undefined;

export function isSecretRequestActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "user-input.requested") return false;
  const payload = activityPayload(activity);
  return payload?.responseMode === "message" && payload?.secretRequest === true;
}

/**
 * The newest secret request cards in a thread, one per request id. A card
 * stays after it resolves so the user sees the outcome row; `display` says
 * which form it takes. A request answered before this client loaded still
 * shows its outcome, never the form.
 */
export function deriveSecretRequestCards(
  threadId: import("@t3tools/contracts").ThreadId,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<{ readonly card: SecretRequestCard; readonly display: SecretRequestDisplay }> {
  const cards = new Map<
    ApprovalRequestId,
    { readonly card: SecretRequestCard; readonly display: SecretRequestDisplay }
  >();
  for (const activity of activities) {
    const payload = activityPayload(activity);
    if (payload === undefined || !isRequestId(payload.requestId)) continue;
    const requestId = payload.requestId;
    if (isSecretRequestActivity(activity)) {
      if (cards.has(requestId)) continue;
      cards.set(requestId, {
        card: {
          requestId,
          threadId: threadId,
          createdAt: activity.createdAt,
          label: typeof payload.label === "string" ? payload.label : "Secret requested",
          reason: typeof payload.reason === "string" ? payload.reason : "",
          ...(typeof payload.placeholder === "string" && payload.placeholder
            ? { placeholder: payload.placeholder }
            : {}),
        },
        display: { kind: "pending" },
      });
    } else if (
      activity.kind === "user-input.resolved" &&
      payload.responseMode === "message" &&
      cards.has(requestId)
    ) {
      const existing = cards.get(requestId);
      if (existing === undefined || existing.display.kind !== "pending") continue;
      const outcome =
        payload.secretStatus === "saved"
          ? "saved"
          : payload.secretStatus === "declined"
            ? "declined"
            : "ended";
      cards.set(requestId, { card: existing.card, display: { kind: "answered", outcome } });
    }
  }
  return [...cards.values()].sort((left, right) =>
    left.card.createdAt.localeCompare(right.card.createdAt),
  );
}

/**
 * Builds the RPC payload for an answer. A save with a blank value returns null,
 * since the server rejects it; callers keep Save disabled instead.
 */
export function secretRequestAnswerInput(
  card: Pick<SecretRequestCard, "threadId" | "requestId">,
  answer: { readonly type: "save"; readonly secret: string } | { readonly type: "decline" },
): SecretRequestAnswerInput | null {
  if (answer.type === "decline") {
    return { threadId: card.threadId, requestId: card.requestId, answer: { type: "decline" } };
  }
  const secret = answer.secret.trim();
  if (secret.length === 0) return null;
  return {
    threadId: card.threadId,
    requestId: card.requestId,
    answer: { type: "save", secret },
  };
}

/** Failures whose message is written for the user and never echoes the request payload. */
const USER_FACING_FAILURE_TAGS = new Set(["SecretRequestError", "EnvironmentAuthorizationError"]);

/**
 * Inline error copy for a failed answer. Only known server errors pass their
 * message through: anything else (transport or encoding failures) gets the
 * generic copy, so the typed value can never surface in the UI.
 */
export function secretRequestFailureMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    USER_FACING_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return "Could not answer the request. Try again.";
}
