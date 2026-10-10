import {
  ApprovalRequestId,
  CommandId,
  EventId,
  type OrchestrationThread,
  SecretRequestError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import {
  RequestSecretUnavailableError,
  SecretsToolkit,
  type RequestSecretInput,
} from "./secretTools.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;
/** A person answers the card, so a slower poll is plenty. */
const SECRET_REQUEST_POLL_INTERVAL_MS = 500;

const SECRET_QUESTION_ID = "secret";

type SecretCardStatus = "pending" | "saved" | "declined" | "cancelled";

/** The newest secret-card activity for a request, and its status. */
const readCardStatus = (
  thread: Pick<OrchestrationThread, "activities">,
  requestId: ApprovalRequestId,
): SecretCardStatus | undefined => {
  let status: SecretCardStatus | undefined;
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : undefined;
    if (payload?.requestId !== requestId) continue;
    if (SecretRequests.internals.isSecretRequestActivity(activity)) {
      status = "pending";
    } else if (
      activity.kind === "user-input.resolved" &&
      payload.responseMode === "message" &&
      typeof payload.secretStatus === "string"
    ) {
      status = SecretRequests.internals.secretStatusOf(activity);
    }
  }
  return status;
};

/** A live turn owns the card; once it ends nobody will receive the ref. */
const turnIsLive = (thread: Pick<OrchestrationThread, "latestTurn" | "session">) =>
  thread.latestTurn?.state === "running" ||
  (thread.session !== null &&
    (thread.session.status === "starting" || thread.session.status === "running"));

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const secretRequests = yield* SecretRequests.SecretRequests;
  const crypto = yield* Crypto.Crypto;

  const loadThread = (threadId: ThreadId) =>
    snapshots.getThreadDetailById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError((cause) => new RequestSecretUnavailableError({ cause })),
    );

  return SecretsToolkit.of({
    request_secret: (input: RequestSecretInput) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const threadId = scope.threadId;
        const thread = yield* loadThread(threadId);
        if (thread === undefined || !turnIsLive(thread)) {
          return yield* new RequestSecretUnavailableError({});
        }
        // A retry with the same clientRequestId finds this card, answered or not.
        const key = input.clientRequestId ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie));
        const requestId = ApprovalRequestId.make(`secret-request:${threadId}:${key}`);
        const existing = readCardStatus(thread, requestId);
        const record = (secretStatus: "pending" | "cancelled") =>
          Effect.flatMap(DateTime.now, (now) => {
            const createdAt = DateTime.formatIso(now);
            return engine
              .dispatch({
                type: "thread.activity.append",
                commandId: CommandId.make(`secret-request:${requestId}:${secretStatus}`),
                threadId,
                activity: {
                  id: EventId.make(`secret-request:${requestId}:${secretStatus}`),
                  tone: "approval",
                  kind: secretStatus === "pending" ? "user-input.requested" : "user-input.resolved",
                  summary:
                    secretStatus === "pending"
                      ? `Secret requested: ${input.label}`
                      : "Secret request ended",
                  payload:
                    secretStatus === "pending"
                      ? {
                          requestId,
                          responseMode: "message",
                          secretRequest: true,
                          label: input.label,
                          reason: input.reason,
                          ...(input.placeholder === undefined
                            ? {}
                            : { placeholder: input.placeholder }),
                          questions: [
                            {
                              id: SECRET_QUESTION_ID,
                              header: input.label,
                              question: input.reason,
                              options: [],
                              allowCustomAnswer: true,
                            },
                          ],
                        }
                      : { requestId, responseMode: "message", secretStatus },
                  turnId: thread.latestTurn?.turnId ?? null,
                  createdAt,
                },
                createdAt,
              })
              .pipe(Effect.mapError((cause) => new RequestSecretUnavailableError({ cause })));
          });

        if (existing === undefined) {
          yield* record("pending");
        }

        // Only this call can hand the agent its ref, so the card must not
        // outlive it: a timeout, a failed wait or an aborted call closes it as
        // cancelled. If even that fails, the server still refuses an answer
        // once the turn ends, and an unused value expires.
        const closeCard = record("cancelled").pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not close a secret request card", { error: error.message }),
          ),
        );

        // The user answers the card (orchestration.answerSecretRequest), or it
        // ends with the turn; poll it like a delegated task.
        const answered = yield* Effect.gen(function* () {
          while (true) {
            const current = yield* loadThread(threadId);
            if (current === undefined) {
              return "cancelled" as const;
            }
            const status = readCardStatus(current, requestId);
            if (status !== undefined && status !== "pending") {
              return status;
            }
            if (!turnIsLive(current)) {
              yield* record("cancelled");
              return "cancelled" as const;
            }
            yield* Effect.sleep(Duration.millis(SECRET_REQUEST_POLL_INTERVAL_MS));
          }
        }).pipe(
          Effect.timeoutOption(
            Duration.millis(
              Math.min(input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS),
            ),
          ),
          Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : closeCard)),
        );
        if (Option.isNone(answered)) yield* closeCard;
        // An answer that raced the timeout still wins: the card is answered once.
        const status = Option.isSome(answered)
          ? answered.value
          : yield* loadThread(threadId).pipe(
              Effect.map((current) => {
                const status =
                  current === undefined ? undefined : readCardStatus(current, requestId);
                return status === "saved" || status === "declined"
                  ? status
                  : ("timed_out" as const);
              }),
              Effect.orElseSucceed(() => "timed_out" as const),
            );
        yield* Effect.annotateCurrentSpan({ "secret_request.status": status });
        if (status !== "saved") return { status };
        // Saved means the value was stored before the card said so; a missing
        // value is a storage fault, not an answer the agent can act on.
        const secretRef = yield* secretRequests.savedRef({ threadId, requestId });
        if (Option.isNone(secretRef)) {
          return yield* new SecretRequestError({
            reason: "record_failed",
            cause: undefined,
          });
        }
        return { status, secretRef: secretRef.value };
      }).pipe(Effect.withSpan("SecretsToolkit.request_secret")),
  });
});

export const SecretsToolkitHandlersLive = SecretsToolkit.toLayer(make);
