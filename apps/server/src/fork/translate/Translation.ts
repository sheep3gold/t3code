import {
  EnvironmentTranslateUnavailableError,
  EnvironmentTranslateUpstreamError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const DEFAULT_BASE_URL = "https://llm.zxytech.cn/v1";
// The owner's model-gateway routes by tier. The translate appKey is restricted
// to `key.models=['auto']`, so the gateway rejects any explicit x-mg-tier
// header (403 "key 不允许显式走 <TIER> 档"); the gateway auto-selects the tier
// from the model and request instead. Its flash models think by default, which
// dominated latency (2.7k chars: ~4.8k reasoning tokens, 19s vs 3.7s without),
// so requests disable thinking; max_tokens keeps headroom for a model that
// ignores the switch, since a small budget leaves an all-reasoning empty reply.
const DEFAULT_MODEL = "auto";
const MAX_TEXTS_PER_REQUEST = 24;
const MAX_TEXT_LENGTH = 16_000;
// With thinking on, ~6000-char batches needed ~10k completion tokens (≈9k
// reasoning) and ~144s. max_tokens caps reasoning + translation together, so a
// small budget truncates the reply into a malformed JSON array, and a short
// timeout aborts a slow-but-valid batch. Both keep that headroom in case an
// upstream model does not honor the thinking switch.
const UPSTREAM_TIMEOUT_SECONDS = 300;
const UPSTREAM_MAX_TOKENS = 32768;
// The gateway's auto-router picks the upstream provider per request, and the
// pick is not reliable: it can land on a provider that is out of credit (a 400
// "Insufficient balance") or one that never answers. Every new request
// re-rolls that pick, so a failed attempt is worth another try. A timeout is
// not retried: it already spent the whole upstream budget, and another attempt
// would only push the answer past the client's deadline.
const UPSTREAM_ATTEMPTS = 3;
const UPSTREAM_RETRY_DELAY = Duration.seconds(1);
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

const TRANSLATE_ENV_FILE = "t3code-translate.env";

const SYSTEM_PROMPT = [
  "You are a translation engine. The user sends JSON: an array of strings.",
  "Translate each element into Simplified Chinese and reply with a JSON array of the same length, in the same order, and nothing else.",
  "Preserve Markdown structure, inline code, links, and code fences exactly; do not translate code, file paths, commands, or identifiers.",
  "If an element is already mostly Chinese, return it unchanged.",
].join(" ");

const ChatCompletionResponse = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({ content: Schema.String }),
    }),
  ),
});

const decodeChatCompletionResponse = Schema.decodeUnknownEffect(ChatCompletionResponse);
const decodeTranslationsJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const encodeTextsJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

/** Minimal KEY=VALUE reader: skips comments, strips one layer of quotes. */
export const parseTranslateEnvFile = (contents: string): string | undefined => {
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    if (trimmed.slice(0, separator).trim() !== "T3CODE_TRANSLATE_API_KEY") continue;
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    return value.length > 0 ? value : undefined;
  }
  return undefined;
};

/**
 * The desktop app spawns its own backend, and a Finder-launched app inherits no
 * shell environment, so `T3CODE_TRANSLATE_API_KEY` is simply absent there and
 * the route answers 503 — which hides the translate buttons for the whole
 * session. Reading the key from `~/.t3/t3code-translate.env` lets each machine
 * supply it without baking a secret into the distributable or editing a launchd
 * plist. Resolved per request so dropping the file in needs no restart.
 */
const resolveApiKey = (
  fileSystem: FileSystem.FileSystem | undefined,
  home: string | undefined,
): Effect.Effect<string | undefined> => {
  const fromEnv = process.env.T3CODE_TRANSLATE_API_KEY?.trim();
  if (fromEnv) return Effect.succeed(fromEnv);
  if (fileSystem === undefined || home === undefined) return Effect.succeed(undefined);
  return fileSystem.readFileString(`${home}/.t3/${TRANSLATE_ENV_FILE}`).pipe(
    Effect.map(parseTranslateEnvFile),
    Effect.orElseSucceed(() => undefined),
  );
};

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

export class Translation extends Context.Service<
  Translation,
  {
    readonly translate: (
      texts: ReadonlyArray<string>,
    ) => Effect.Effect<
      { readonly translations: ReadonlyArray<string> },
      EnvironmentTranslateUnavailableError | EnvironmentTranslateUpstreamError
    >;
  }
>()("t3/fork/translate/Translation") {}
const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  // Optional so the route also composes where no FileSystem is provided; the
  // env-file fallback then simply cannot apply.
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem).pipe(
    Effect.map(Option.getOrUndefined),
  );
  const translate = Effect.fn("Translation.translate")(function* (texts: ReadonlyArray<string>) {
    const apiKey = yield* resolveApiKey(fileSystem, process.env.HOME);
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

    // max_tokens caps the TOTAL completion output of one upstream call, so a
    // long text cannot go through as one big JSON array — the reply is
    // truncated mid-array and used to surface as a 502 after the 60s timeout.
    // Send the chunks in batches whose combined source length fits the output
    // budget; every batch gets its own full budget.
    const chunkBatches: Array<Array<string>> = [];
    let currentBatch: Array<string> = [];
    let currentBatchLength = 0;
    for (const chunk of chunks) {
      if (currentBatch.length > 0 && currentBatchLength + chunk.length > UPSTREAM_BATCH_LENGTH) {
        chunkBatches.push(currentBatch);
        currentBatch = [];
        currentBatchLength = 0;
      }
      currentBatch.push(chunk);
      currentBatchLength += chunk.length;
    }
    if (currentBatch.length > 0) chunkBatches.push(currentBatch);

    const upstreamError = (message: string) => new EnvironmentTranslateUpstreamError({ message });
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
          const upstreamJson = yield* Effect.gen(function* () {
            for (let attempt = 1; attempt <= UPSTREAM_ATTEMPTS; attempt++) {
              const result = yield* httpClient
                .execute(
                  HttpClientRequest.post(`${baseUrl}/chat/completions`).pipe(
                    HttpClientRequest.setHeader("Authorization", `Bearer ${apiKey}`),
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
                  Effect.result,
                );
              if (Result.isSuccess(result)) return result.success;
              if (attempt >= UPSTREAM_ATTEMPTS || Cause.isTimeoutError(result.failure)) {
                yield* Effect.logWarning("Translation upstream request failed", {
                  batchIndex,
                  attempt,
                });
                return yield* upstreamError("Translation upstream failed.");
              }
              yield* Effect.logWarning("Translation upstream request failed; retrying", {
                batchIndex,
                attempt,
              });
              yield* Effect.sleep(UPSTREAM_RETRY_DELAY);
            }
            return yield* upstreamError("Translation upstream failed.");
          });
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
              (translation, index) => !preservesTranslationStructure(input[index]!, translation),
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
  });
  return Translation.of({ translate });
});
export const layer = Layer.effect(Translation, make);
