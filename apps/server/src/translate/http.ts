/**
 * Chat translation proxy. Clients send natural-language message text here; the
 * server forwards it to an OpenAI-compatible chat-completions endpoint (the
 * owner's model-gateway by default) and returns the Chinese translation.
 * Keeping the appKey server-side means clients never see it.
 *
 * Config is environment-only:
 * - T3CODE_TRANSLATE_API_KEY   required; when unset the route answers 503.
 * - T3CODE_TRANSLATE_BASE_URL  defaults to the model-gateway public entry.
 * - T3CODE_TRANSLATE_MODEL     defaults to a SIMPLE-tier flash model.
 *
 * Auth runs inside the handler (not the shared auth middleware): the desktop
 * shell's page origin is the t3code:// asset protocol and cannot send
 * Authorization headers cross-origin without a CORS preflight the custom
 * scheme cannot express, so bearer/DPoP clients there authenticate with a
 * short-lived `wsTicket` query parameter — the same fallback the /ws upgrade
 * and the device-hub proxy use. `authenticateWebSocketUpgrade` accepts the
 * ticket first and falls back to the standard bearer/DPoP/cookie credentials,
 * so mobile and relay clients keep working unchanged.
 */
import {
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
  EnvironmentTranslateUnavailableError,
  EnvironmentTranslateUpstreamError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
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
// The SIMPLE-tier models are reasoning models whose thinking scales with input
// length/complexity: measured production batches of ~6000 source chars needed
// ~10k completion tokens (≈9k reasoning) and ~144s to finish. max_tokens caps
// reasoning + translation together, so a small budget truncates the reply into
// a malformed JSON array (502 "Unexpected upstream response"), and a short
// client timeout aborts a slow-but-valid batch (502 "Translation upstream
// failed"). Both budgets are sized with generous headroom over those numbers.
const UPSTREAM_TIMEOUT_SECONDS = 300;
const UPSTREAM_MAX_TOKENS = 32768;
// Long messages exceed the upstream token budget in one shot (a reasoning
// flash model burns the budget on thinking, or the JSON array is truncated).
// Split long texts at paragraph boundaries and translate the chunks in batches
// sized to the output budget.
const CHUNK_TARGET_LENGTH = 2_000;
// Combined source length per upstream call, keeping the reply well under
// UPSTREAM_MAX_TOKENS even with reasoning overhead on top of the translation.
const UPSTREAM_BATCH_LENGTH = 6_000;

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

export interface TextChunks {
  readonly chunks: Array<string>;
  /** separators[i] joins chunks[i] and chunks[i+1] ("\n\n" or "\n"). */
  readonly separators: Array<string>;
}

/**
 * Split a long text at paragraph boundaries into chunks of roughly
 * `targetLength`, never splitting inside a line. A text that already fits is
 * returned as a single chunk. Joining the translated chunks back with
 * `separators` preserves the original line/paragraph structure exactly.
 */
export const chunkText = (text: string, targetLength = CHUNK_TARGET_LENGTH): TextChunks => {
  if (text.length <= targetLength) return { chunks: [text], separators: [] };
  const paragraphs = text.split("\n\n");
  const chunks: Array<string> = [];
  // boundaries[i] is the separator following chunks[i]; the last entry is a
  // placeholder sliced off at the end.
  const boundaries: Array<string> = [];
  const flush = (chunk: string, after: string) => {
    chunks.push(chunk);
    boundaries.push(after);
  };
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
    if (candidate.length <= targetLength) {
      current = candidate;
      continue;
    }
    if (current.length > 0) flush(current, "\n\n");
    if (paragraph.length <= targetLength) {
      current = paragraph;
      continue;
    }
    // A single oversized paragraph falls back to splitting on newlines.
    let lineChunk = "";
    for (const line of paragraph.split("\n")) {
      const candidateLine = lineChunk.length === 0 ? line : `${lineChunk}\n${line}`;
      if (candidateLine.length <= targetLength) {
        lineChunk = candidateLine;
        continue;
      }
      if (lineChunk.length > 0) flush(lineChunk, "\n");
      lineChunk = line;
    }
    current = lineChunk;
  }
  if (current.length > 0) flush(current, "");
  return { chunks, separators: boundaries.slice(0, -1) };
};

/** Join translated chunks back into one text with the recorded separators. */
export const joinChunks = (chunks: ReadonlyArray<string>, separators: ReadonlyArray<string>) =>
  chunks.reduce(
    (acc, chunk, index) => (index === 0 ? chunk : `${acc}${separators[index - 1]}${chunk}`),
    "",
  );

export const translateHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "translate",
  Effect.fnUntraced(function* (handlers) {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

    return handlers.handleRaw(
      "translate",
      Effect.fn("environment.translate.translate")(function* ({ request }) {
        yield* annotateEnvironmentRequest("translate");
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
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
          return yield* new EnvironmentTranslateUnavailableError({
            message: "Translation is not configured on this server.",
          });
        }
        const baseUrl = (process.env.T3CODE_TRANSLATE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
          /\/+$/,
          "",
        );
        const model = process.env.T3CODE_TRANSLATE_MODEL?.trim() || DEFAULT_MODEL;

        // handleRaw opts out of automatic payload decoding so the auth above
        // can run before the body is consumed; limits are enforced here.
        const bodyJson = yield* request.json.pipe(
          Effect.mapError(
            () => new EnvironmentTranslateUpstreamError({ message: "Invalid JSON body." }),
          ),
        );
        const decoded = yield* decodeTranslateRequestBody(bodyJson).pipe(
          Effect.mapError(
            () =>
              new EnvironmentTranslateUpstreamError({ message: "Expected { texts: string[] }." }),
          ),
        );
        const texts = decoded.texts;
        if (texts.length > MAX_TEXTS_PER_REQUEST) {
          return yield* new EnvironmentTranslateUpstreamError({
            message: `At most ${MAX_TEXTS_PER_REQUEST} texts per request.`,
          });
        }
        if (texts.some((text) => text.length > MAX_TEXT_LENGTH)) {
          return yield* new EnvironmentTranslateUpstreamError({
            message: `Texts must be at most ${MAX_TEXT_LENGTH} characters.`,
          });
        }
        if (texts.length === 0) {
          return { translations: [] };
        }

        // Expand each input text into budget-sized chunks and remember how many
        // chunks each text produced and which separators join them, so the
        // translated chunks can be joined back into one translation per input.
        const chunkCounts: Array<number> = [];
        const chunkSeparators: Array<ReadonlyArray<string>> = [];
        const chunks: Array<string> = [];
        for (const text of texts) {
          const textChunks = chunkText(text);
          chunkCounts.push(textChunks.chunks.length);
          chunkSeparators.push(textChunks.separators);
          chunks.push(...textChunks.chunks);
        }

        const httpClient = yield* HttpClient.HttpClient;

        // max_tokens caps the TOTAL completion output of one upstream call, so a
        // long text cannot go through as one big JSON array — the reply is
        // truncated mid-array and used to surface as a 502 after the 60s timeout.
        // Send the chunks in batches whose combined source length fits the output
        // budget; every batch gets its own full budget.
        const chunkBatches: Array<Array<string>> = [];
        let currentBatch: Array<string> = [];
        let currentBatchLength = 0;
        for (const chunk of chunks) {
          if (
            currentBatch.length > 0 &&
            currentBatchLength + chunk.length > UPSTREAM_BATCH_LENGTH
          ) {
            chunkBatches.push(currentBatch);
            currentBatch = [];
            currentBatchLength = 0;
          }
          currentBatch.push(chunk);
          currentBatchLength += chunk.length;
        }
        if (currentBatch.length > 0) chunkBatches.push(currentBatch);

        const upstreamError = (message: string) =>
          new EnvironmentTranslateUpstreamError({ message });
        const translatedChunks: Array<string> = [];
        for (const [batchIndex, batch] of chunkBatches.entries()) {
          const textsJson = yield* encodeTextsJson(batch).pipe(
            Effect.mapError(() => upstreamError("Could not encode texts.")),
          );
          const requestBatchTranslations = Effect.gen(function* () {
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
                Effect.timeout(`${UPSTREAM_TIMEOUT_SECONDS} seconds`),
                Effect.tapError((cause) =>
                  Effect.logWarning("Translation upstream request failed", { cause, batchIndex }),
                ),
                Effect.mapError(() => upstreamError("Translation upstream failed.")),
              );
            const completion = yield* decodeChatCompletionResponse(upstreamJson).pipe(
              Effect.mapError(() => upstreamError("Unexpected upstream response.")),
            );
            const content = completion.choices[0]?.message.content ?? "";
            if (content.length === 0) {
              // Reasoning flash models can spend the whole budget on thinking; the
              // client falls back to untranslated text on 502 and retries later.
              yield* Effect.logWarning("Translation upstream returned empty content", {
                batchIndex,
              });
              return yield* upstreamError("Translation upstream returned empty content.");
            }
            const batchTranslations = yield* parseTranslationsJson(content);
            if (batchTranslations === null || batchTranslations.length !== batch.length) {
              return yield* upstreamError("Translation response malformed.");
            }
            return batchTranslations;
          });

          const isMalformedUpstream = (
            error: EnvironmentTranslateUpstreamError,
          ): error is EnvironmentTranslateUpstreamError =>
            error.message === "Translation response malformed.";
          const batchTranslations = yield* requestBatchTranslations.pipe(
            Effect.catchIf(isMalformedUpstream, () =>
              Effect.gen(function* () {
                // Long reasoning outputs occasionally leave one JSON escape
                // malformed; asking the model again usually returns a usable
                // array, so absorb that transient upstream defect instead of
                // surfacing an immediate 502 to the client.
                yield* Effect.logWarning("Translation response could not be parsed; retrying", {
                  batchIndex,
                  expected: batch.length,
                });
                return yield* requestBatchTranslations.pipe(
                  Effect.catchIf(isMalformedUpstream, (retryError) =>
                    Effect.gen(function* () {
                      yield* Effect.logWarning("Translation response could not be parsed", {
                        batchIndex,
                        expected: batch.length,
                      });
                      return yield* retryError;
                    }),
                  ),
                );
              }),
            ),
          );
          translatedChunks.push(...batchTranslations);
        }

        // Join each input text's translated chunks back into one translation.
        const translations: Array<string> = [];
        let offset = 0;
        for (const [textIndex, count] of chunkCounts.entries()) {
          translations.push(
            joinChunks(translatedChunks.slice(offset, offset + count), chunkSeparators[textIndex]!),
          );
          offset += count;
        }
        return { translations };
      }),
    );
  }),
);
