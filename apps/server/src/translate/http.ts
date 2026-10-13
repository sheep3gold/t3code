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

const TRANSLATE_ROUTE_PATH = "/api/translate";

const DEFAULT_BASE_URL = "https://llm.zxytech.cn/v1";
// The owner's model-gateway routes by tier; appKeys only allow "auto" and the
// SIMPLE tier keeps translation cheap. Its flash models think by default, which
// dominated latency (2.7k chars: ~4.8k reasoning tokens, 19s vs 3.7s without),
// so requests disable thinking; max_tokens keeps headroom for a model that
// ignores the switch, since a small budget leaves an all-reasoning empty reply.
const DEFAULT_MODEL = "auto";
const GATEWAY_TIER = "SIMPLE";
const MAX_TEXTS_PER_REQUEST = 24;
const MAX_TEXT_LENGTH = 16_000;
// With thinking on, ~6000-char batches needed ~10k completion tokens (≈9k
// reasoning) and ~144s. max_tokens caps reasoning + translation together, so a
// small budget truncates the reply into a malformed JSON array, and a short
// timeout aborts a slow-but-valid batch. Both keep that headroom in case an
// upstream model does not honor the thinking switch.
const UPSTREAM_TIMEOUT_SECONDS = 300;
const UPSTREAM_MAX_TOKENS = 32768;
// Long messages exceed the upstream token budget in one shot (a reasoning
// flash model burns the budget on thinking, or the JSON array is truncated).
// Split long texts at paragraph boundaries and translate the chunks in batches
// sized to the output budget.
const CHUNK_TARGET_LENGTH = 2_000;
// Combined source length per upstream call. Batches run concurrently, so
// smaller batches finish a long message sooner than a few large serial ones.
const UPSTREAM_BATCH_LENGTH = 2_000;
const UPSTREAM_BATCH_CONCURRENCY = 4;
const MAX_MALFORMED_RECOVERY_DEPTH = 4;

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

/** Reject structurally incomplete translations even when the JSON array shape is valid. */
export const preservesTranslationStructure = (source: string, translated: string) => {
  if (source.trim() && !translated.trim()) return false;
  if ((source.match(/\n\n/g)?.length ?? 0) !== (translated.match(/\n\n/g)?.length ?? 0)) {
    return false;
  }
  if ((source.match(/```/g)?.length ?? 0) !== (translated.match(/```/g)?.length ?? 0)) {
    return false;
  }
  const protectedParts = [
    ...(source.match(/```[\s\S]*?```/g) ?? []),
    ...(source.match(/https?:\/\/[^\s)>\]]+/g) ?? []).map((url) => url.replace(/[.,!?;:]+$/, "")),
    ...(source.match(/`[^`\n]+`/g) ?? []),
  ];
  return protectedParts.every((part) => translated.includes(part));
};

export interface TextChunks {
  readonly chunks: Array<string>;
  /** separators[i] joins chunks[i] and chunks[i+1] ("\n\n", "\n", or ""). */
  readonly separators: Array<string>;
}

/**
 * Split at paragraph and line boundaries, then split oversized single lines
 * at spaces (or code-point boundaries if necessary). A text that already fits
 * is returned as a single chunk. Joining with `separators` reconstructs the
 * source exactly.
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
  let current: string | null = null;
  for (const paragraph of paragraphs) {
    const candidate: string = current === null ? paragraph : `${current}\n\n${paragraph}`;
    if (candidate.length <= targetLength) {
      current = candidate;
      continue;
    }
    if (current !== null) flush(current, "\n\n");
    if (paragraph.length <= targetLength) {
      current = paragraph;
      continue;
    }
    // A single oversized paragraph falls back to lines; an oversized line
    // must not bypass the upstream batch budget either.
    let lineChunk: string | null = null;
    for (const line of paragraph.split("\n")) {
      const candidateLine: string = lineChunk === null ? line : `${lineChunk}\n${line}`;
      if (candidateLine.length <= targetLength) {
        lineChunk = candidateLine;
        continue;
      }
      if (lineChunk !== null) flush(lineChunk, "\n");
      let rest = line;
      while (rest.length > targetLength) {
        let splitAt = rest.lastIndexOf(" ", targetLength - 1);
        if (splitAt < targetLength / 2) {
          splitAt = targetLength;
          // Avoid splitting a UTF-16 surrogate pair in an unspaced line.
          if (rest.charCodeAt(splitAt) >= 0xdc00 && rest.charCodeAt(splitAt) <= 0xdfff) {
            splitAt--;
          }
        } else {
          splitAt++;
        }
        flush(rest.slice(0, splitAt), "");
        rest = rest.slice(splitAt);
      }
      lineChunk = rest;
    }
    current = lineChunk;
  }
  if (current !== null) flush(current, "");
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
        const translateBatch = (batch: ReadonlyArray<string>, batchIndex: number) => {
          let upstreamCalls = 0;
          const requestBatchTranslations = (input: ReadonlyArray<string>) =>
            Effect.gen(function* () {
              if (++upstreamCalls > 20) {
                return yield* upstreamError("Translation response malformed.");
              }
              const textsJson = yield* encodeTextsJson(input).pipe(
                Effect.mapError(() => upstreamError("Could not encode texts.")),
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
                      thinking: { type: "disabled" },
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
                yield* Effect.logWarning("Translation upstream returned empty content", {
                  batchIndex,
                });
                return yield* upstreamError("Translation upstream returned empty content.");
              }
              const translations = yield* parseTranslationsJson(content);
              if (
                translations === null ||
                translations.length !== input.length ||
                translations.some(
                  (translation, index) =>
                    !preservesTranslationStructure(input[index]!, translation),
                )
              ) {
                return yield* upstreamError("Translation response malformed.");
              }
              return [...translations];
            });

          const isMalformedUpstream = (error: EnvironmentTranslateUpstreamError) =>
            error.message === "Translation response malformed.";
          const translateWithRecovery = (
            input: ReadonlyArray<string>,
            depth: number,
          ): Effect.Effect<Array<string>, EnvironmentTranslateUpstreamError> =>
            Effect.gen(function* () {
              if (input.every((text) => !text.trim())) return [...input];
              const translations = yield* requestBatchTranslations(input).pipe(
                Effect.catchIf(isMalformedUpstream, () =>
                  Effect.gen(function* () {
                    yield* Effect.logWarning("Translation response malformed; retrying", {
                      batchIndex,
                      depth,
                      expected: input.length,
                    });
                    return yield* requestBatchTranslations(input).pipe(
                      Effect.catchIf(isMalformedUpstream, () => Effect.succeed(null)),
                    );
                  }),
                ),
              );
              if (translations !== null) return translations;
              if (depth >= MAX_MALFORMED_RECOVERY_DEPTH || upstreamCalls >= 20) {
                yield* Effect.logWarning("Translation response malformed", { batchIndex, depth });
                return yield* upstreamError("Translation response malformed.");
              }

              // Only translate the *original* inputs again. The model sometimes
              // turns one multi-paragraph array item into several shortened items;
              // joining those outputs would silently lose text.
              if (input.length > 1) {
                const recovered = yield* Effect.forEach(
                  input,
                  (text) => translateWithRecovery([text], depth + 1),
                  { concurrency: 1 },
                );
                return recovered.flat();
              }
              const source = input[0]!;
              const { chunks: parts, separators } = chunkText(
                source,
                Math.max(100, source.length >> 1),
              );
              if (parts.length < 2) {
                yield* Effect.logWarning("Translation response malformed", { batchIndex, depth });
                return yield* upstreamError("Translation response malformed.");
              }
              const recovered = yield* Effect.forEach(
                parts,
                (part) => translateWithRecovery([part], depth + 1),
                { concurrency: 1 },
              );
              return [
                joinChunks(
                  recovered.map(([text]) => text!),
                  separators,
                ),
              ];
            });

          return translateWithRecovery(batch, 0);
        };
        const translatedChunks = (yield* Effect.forEach(chunkBatches, translateBatch, {
          concurrency: UPSTREAM_BATCH_CONCURRENCY,
        })).flat();

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
