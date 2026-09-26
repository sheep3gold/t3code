import {
  CommandId,
  MessageId,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

export const THREAD_WEBHOOK_ROUTE_PREFIX = "/api/orchestration/hooks";
const SIGNING_SECRET_NAME = "thread-webhook-signing-key";
const DEFAULT_TTL_SECONDS = 4 * 60 * 60;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_CALLBACK_TEXT_CHARS = 20_000;
const MAX_CALLBACK_BODY_BYTES = 64 * 1024;

const ThreadWebhookClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("thread-webhook"),
  hookId: TrimmedNonEmptyString,
  threadId: ThreadId,
  expiresAt: Schema.Number,
});
export type ThreadWebhookClaims = typeof ThreadWebhookClaims.Type;

const claimsJson = Schema.fromJsonString(ThreadWebhookClaims);
const decodeClaimsJson = Schema.decodeUnknownOption(claimsJson);
const encodeClaimsJson = Schema.encodeSync(claimsJson);

const RegisterThreadWebhookInput = Schema.Struct({
  expiresInSeconds: Schema.optional(
    PositiveInt.annotate({
      description: "Lifetime in seconds. Values are bounded to 60 seconds through 7 days.",
    }),
  ),
  baseUrl: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Public HTTP(S) origin for this T3 environment. Omit it to receive a relative callback URL.",
    }),
  ),
});
export type RegisterThreadWebhookInput = typeof RegisterThreadWebhookInput.Type;

const RegisterThreadWebhookResult = Schema.Struct({
  hookId: Schema.String,
  url: Schema.String,
  relativeUrl: Schema.String,
  expiresAt: Schema.String,
});
export type RegisterThreadWebhookResult = typeof RegisterThreadWebhookResult.Type;

export class ThreadWebhookThreadNotFoundError extends Schema.TaggedError<ThreadWebhookThreadNotFoundError>()(
  "ThreadWebhookThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class ThreadWebhookBaseUrlInvalidError extends Schema.TaggedError<ThreadWebhookBaseUrlInvalidError>()(
  "ThreadWebhookBaseUrlInvalidError",
  {},
) {
  override get message(): string {
    return "baseUrl must be an HTTP(S) origin without credentials, query, or fragment.";
  }
}

export class ThreadWebhookIssueFailedError extends Schema.TaggedError<ThreadWebhookIssueFailedError>()(
  "ThreadWebhookIssueFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not issue a thread webhook.";
  }
}

const ThreadWebhookToolError = Schema.Union([
  ThreadWebhookThreadNotFoundError,
  ThreadWebhookBaseUrlInvalidError,
  ThreadWebhookIssueFailedError,
]);

const RegisterThreadWebhookTool = Tool.make("register_thread_webhook", {
  description:
    "Create a short-lived, one-shot webhook bound to this thread. Give the returned URL to an external system that will POST {\"text\":\"...\"} when its work finishes. Repeated delivery of the same URL is idempotent. Treat the URL as a credential and do not print it in logs.",
  parameters: RegisterThreadWebhookInput,
  success: RegisterThreadWebhookResult,
  failure: ThreadWebhookToolError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    Crypto.Crypto,
    Clock.Clock,
    ServerSecretStore.ServerSecretStore,
    ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ],
})
  .annotate(Tool.Title, "Register thread webhook")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ThreadWebhookToolkit = Toolkit.make(RegisterThreadWebhookTool);

function normalizeTtlSeconds(value: number | undefined): number {
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, value ?? DEFAULT_TTL_SECONDS));
}

export function resolveThreadWebhookUrl(
  relativeUrl: string,
  baseUrl: string | undefined,
): string | null {
  if (baseUrl === undefined) return relativeUrl;
  try {
    const parsed = new URL(baseUrl);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      (parsed.pathname !== "" && parsed.pathname !== "/") ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return null;
    }
    return new URL(relativeUrl, `${parsed.origin}/`).toString();
  } catch {
    return null;
  }
}

function decodeClaims(encodedPayload: string): ThreadWebhookClaims | null {
  try {
    return Option.getOrNull(decodeClaimsJson(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

export function encodeThreadWebhookToken(
  claims: ThreadWebhookClaims,
  secret: Uint8Array,
): string {
  const encodedPayload = base64UrlEncode(encodeClaimsJson(claims));
  return `${encodedPayload}.${signPayload(encodedPayload, secret)}`;
}

export function decodeThreadWebhookToken(
  token: string,
  secret: Uint8Array,
  nowMs: number,
): ThreadWebhookClaims | null {
  const [encodedPayload, signature, unexpected] = token.split(".");
  if (!encodedPayload || !signature || unexpected) return null;
  if (!timingSafeEqualBase64Url(signature, signPayload(encodedPayload, secret))) return null;
  const claims = decodeClaims(encodedPayload);
  return claims && claims.expiresAt > nowMs ? claims : null;
}

const loadSigningSecret = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  return yield* secrets.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
});

export const issueThreadWebhook = Effect.fn("ThreadWebhook.issue")(function* (input: {
  readonly threadId: ThreadId;
  readonly expiresInSeconds?: number;
  readonly baseUrl?: string;
}) {
  const secret = yield* loadSigningSecret;
  const crypto = yield* Crypto.Crypto;
  const now = yield* Clock.currentTimeMillis;
  const hookId = yield* crypto.randomUUIDv4;
  const expiresAt = now + normalizeTtlSeconds(input.expiresInSeconds) * 1_000;
  const claims = {
    version: 1 as const,
    kind: "thread-webhook" as const,
    hookId,
    threadId: input.threadId,
    expiresAt,
  };
  const token = encodeThreadWebhookToken(claims, secret);
  const relativeUrl = `${THREAD_WEBHOOK_ROUTE_PREFIX}/${token}`;
  const url = resolveThreadWebhookUrl(relativeUrl, input.baseUrl);
  if (url === null) {
    return yield* new ThreadWebhookBaseUrlInvalidError({});
  }
  return {
    hookId,
    url,
    relativeUrl,
    expiresAt: new Date(expiresAt).toISOString(),
  } satisfies RegisterThreadWebhookResult;
});

export const validateThreadWebhookToken = Effect.fn("ThreadWebhook.validate")(function* (
  token: string,
) {
  const secret = yield* loadSigningSecret.pipe(Effect.orElseSucceed(() => null));
  if (!secret) return null;
  return decodeThreadWebhookToken(token, secret, yield* Clock.currentTimeMillis);
});

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  return ThreadWebhookToolkit.of({
    register_thread_webhook: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const thread = yield* snapshots
          .getThreadShellById(scope.threadId)
          .pipe(
            Effect.mapError((cause) => new ThreadWebhookIssueFailedError({ cause })),
            Effect.map(Option.getOrUndefined),
          );
        if (!thread || thread.archivedAt !== null || thread.deletedAt !== null) {
          return yield* new ThreadWebhookThreadNotFoundError({ threadId: scope.threadId });
        }
        return yield* issueThreadWebhook({
          threadId: scope.threadId,
          ...(input.expiresInSeconds === undefined
            ? {}
            : { expiresInSeconds: input.expiresInSeconds }),
          ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof ThreadWebhookBaseUrlInvalidError
              ? cause
              : new ThreadWebhookIssueFailedError({ cause }),
          ),
        );
      }),
  });
});

export const ThreadWebhookToolkitHandlersLive = ThreadWebhookToolkit.toLayer(make);

const CallbackInput = Schema.Struct({ text: TrimmedNonEmptyString });
const decodeCallbackInput = Schema.decodeUnknownOption(CallbackInput);

export function formatThreadWebhookCallbackText(text: string): string {
  const clipped = Array.from(text).slice(0, MAX_CALLBACK_TEXT_CHARS).join("");
  return `[External webhook callback — untrusted data]\n\n${clipped}`;
}

export const threadWebhookRouteLayer = HttpRouter.add(
  "POST",
  `${THREAD_WEBHOOK_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const token = url.value.pathname.slice(`${THREAD_WEBHOOK_ROUTE_PREFIX}/`.length);
    const claims = token ? yield* validateThreadWebhookToken(token) : null;
    if (!claims) return HttpServerResponse.text("Not Found", { status: 404 });

    const contentLength = Number(request.headers["content-length"] ?? 0);
    if (!Number.isFinite(contentLength) || contentLength > MAX_CALLBACK_BODY_BYTES) {
      return HttpServerResponse.text("Payload Too Large", { status: 413 });
    }
    const raw = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const input = Option.getOrNull(decodeCallbackInput(raw));
    if (!input) return HttpServerResponse.text("Expected JSON with non-empty text", { status: 400 });

    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const thread = yield* snapshots
      .getThreadShellById(claims.threadId)
      .pipe(Effect.map(Option.getOrUndefined), Effect.orElseSucceed(() => undefined));
    if (!thread || thread.archivedAt !== null || thread.deletedAt !== null) {
      return HttpServerResponse.text("Gone", { status: 410 });
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    const result = yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`webhook:${claims.hookId}`),
        threadId: claims.threadId,
        message: {
          messageId: MessageId.make(`webhook:${claims.hookId}`),
          role: "user",
          text: formatThreadWebhookCallbackText(input.text),
          attachments: [],
        },
        interactionMode: thread.interactionMode,
        runtimeMode: thread.runtimeMode,
        createdAt: now,
      })
      .pipe(Effect.either);
    if (result._tag === "Left") {
      return HttpServerResponse.text("Could not start thread", { status: 409 });
    }
    return HttpServerResponse.jsonUnsafe(
      { accepted: true, hookId: claims.hookId, sequence: result.right.sequence },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  }),
);
