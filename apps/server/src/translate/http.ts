/**
 * Chat translation proxy. The web client sends natural-language message text
 * here; the server forwards it to an OpenAI-compatible chat-completions
 * endpoint (the owner's model-gateway by default) and returns the Chinese
 * translation. Keeping the appKey server-side means browser clients never
 * see it.
 *
 * Config is environment-only:
 * - T3CODE_TRANSLATE_API_KEY   required; when unset the route answers 503.
 * - T3CODE_TRANSLATE_BASE_URL  defaults to the model-gateway public entry.
 * - T3CODE_TRANSLATE_MODEL     defaults to a SIMPLE-tier flash model.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";

import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

export const TRANSLATE_ROUTE_PATH = "/api/translate";

const DEFAULT_BASE_URL = "https://llm.zxytech.cn/v1";
// The owner's model-gateway routes by tier; appKeys only allow "auto" and the
// SIMPLE tier keeps translation cheap (its flash models think, so a real
// max_tokens budget is mandatory — too small and the reply is all reasoning
// with an empty content).
const DEFAULT_MODEL = "auto";
const GATEWAY_TIER = "SIMPLE";
const MAX_TEXTS_PER_REQUEST = 24;
const MAX_TEXT_LENGTH = 16_000;
const UPSTREAM_MAX_TOKENS = 4096;

const SYSTEM_PROMPT = [
  "You are a translation engine. The user sends JSON: an array of strings.",
  "Translate each element into Simplified Chinese and reply with a JSON array of the same length, in the same order, and nothing else.",
  "Preserve Markdown structure, inline code, links, and code fences exactly; do not translate code, file paths, commands, or identifiers.",
  "If an element is already mostly Chinese, return it unchanged.",
].join(" ");

const TranslateRequestBody = Schema.Struct({
  texts: Schema.Array(Schema.String),
});

const ChatCompletionResponse = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({ content: Schema.String }),
    }),
  ),
});

const decodeChatCompletionResponse = Schema.decodeUnknownEffect(ChatCompletionResponse);
const decodeTranslateRequestBody = Schema.decodeUnknownEffect(TranslateRequestBody);
const decodeTranslationsJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const encodeTextsJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

/** The model answers with a JSON array; tolerate code fences around it. */
export const parseTranslationsJson = (content: string) => {
  const trimmed = content.trim();
  const withoutFence = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  return decodeTranslationsJson(withoutFence).pipe(Effect.orElseSucceed(() => null));
};

export const translateRouteLayer = HttpRouter.add(
  "POST",
  TRANSLATE_ROUTE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(
          EnvironmentAuth.serverAuthCredentialReason(error),
          EnvironmentAuth.serverAuthDpopFailureReason(error),
        ),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
      return yield* failEnvironmentScopeRequired(AuthOrchestrationOperateScope);
    }

    const apiKey = process.env.T3CODE_TRANSLATE_API_KEY?.trim();
    if (!apiKey) {
      return HttpServerResponse.jsonUnsafe(
        { error: "translation_not_configured" },
        { status: 503 },
      );
    }
    const baseUrl = (process.env.T3CODE_TRANSLATE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    const model = process.env.T3CODE_TRANSLATE_MODEL?.trim() || DEFAULT_MODEL;

    const bodyJson = yield* request.json.pipe(
      Effect.mapError(() => HttpServerResponse.text("Invalid JSON body.", { status: 400 })),
    );
    const decoded = yield* decodeTranslateRequestBody(bodyJson).pipe(
      Effect.mapError(() =>
        HttpServerResponse.text("Expected { texts: string[] }.", { status: 400 }),
      ),
    );
    const texts = decoded.texts;
    if (texts.length > MAX_TEXTS_PER_REQUEST) {
      return yield* Effect.fail(
        HttpServerResponse.text(`At most ${MAX_TEXTS_PER_REQUEST} texts per request.`, {
          status: 413,
        }),
      );
    }
    if (texts.some((text) => text.length > MAX_TEXT_LENGTH)) {
      return yield* Effect.fail(
        HttpServerResponse.text(`Texts must be at most ${MAX_TEXT_LENGTH} characters.`, {
          status: 413,
        }),
      );
    }
    if (texts.length === 0) {
      return HttpServerResponse.jsonUnsafe({ translations: [] });
    }

    const httpClient = yield* HttpClient.HttpClient;
    const textsJson = yield* encodeTextsJson(texts).pipe(
      Effect.mapError(() => HttpServerResponse.text("Could not encode texts.", { status: 500 })),
    );
    const upstreamJson = yield* httpClient
      .execute(
        HttpClientRequest.post(`${baseUrl}/chat/completions`).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${apiKey}`),
          HttpClientRequest.setHeader("x-mg-tier", GATEWAY_TIER),
          HttpClientRequest.bodyJsonUnsafe({
            model,
            temperature: 0,
            max_tokens: UPSTREAM_MAX_TOKENS,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: textsJson },
            ],
          }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout("60 seconds"),
        Effect.tapError((cause) =>
          Effect.logWarning("Translation upstream request failed", { cause }),
        ),
        Effect.mapError(() =>
          HttpServerResponse.text("Translation upstream failed.", { status: 502 }),
        ),
      );
    const completion = yield* decodeChatCompletionResponse(upstreamJson).pipe(
      Effect.mapError(() =>
        HttpServerResponse.text("Unexpected upstream response.", { status: 502 }),
      ),
    );
    const content = completion.choices[0]?.message.content ?? "";
    if (content.length === 0) {
      // Reasoning flash models can spend the whole budget on thinking; the
      // client falls back to untranslated text on 502 and retries later.
      yield* Effect.logWarning("Translation upstream returned empty content");
      return yield* Effect.fail(
        HttpServerResponse.text("Translation upstream returned empty content.", { status: 502 }),
      );
    }
    const translations = yield* parseTranslationsJson(content);
    if (translations === null || translations.length !== texts.length) {
      yield* Effect.logWarning("Translation response could not be parsed", {
        expected: texts.length,
      });
      return yield* Effect.fail(
        HttpServerResponse.text("Translation response malformed.", { status: 502 }),
      );
    }
    return HttpServerResponse.jsonUnsafe({ translations });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
    // Validation/upstream failures above fail with a ready-made response;
    // those must come back as answers, not defects.
    Effect.catch((failure: unknown) =>
      HttpServerRespondable.isRespondable(failure)
        ? HttpServerRespondable.toResponse(failure)
        : Effect.fail(failure as never),
    ),
  ),
);
