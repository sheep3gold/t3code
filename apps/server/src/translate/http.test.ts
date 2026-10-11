import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { chunkText, joinChunks, parseTranslationsJson } from "./http.ts";

it.effect("parses a plain JSON string array", () =>
  Effect.gen(function* () {
    const parsed = yield* parseTranslationsJson('["你好","世界"]');
    expect(parsed).toEqual(["你好", "世界"]);
  }),
);

it.effect("tolerates a json code fence around the array", () =>
  Effect.gen(function* () {
    const parsed = yield* parseTranslationsJson('```json\n["你好"]\n```');
    expect(parsed).toEqual(["你好"]);
  }),
);

it.effect("tolerates a bare code fence", () =>
  Effect.gen(function* () {
    const parsed = yield* parseTranslationsJson('```\n["你好"]\n```');
    expect(parsed).toEqual(["你好"]);
  }),
);

it.effect("rejects non-array JSON", () =>
  Effect.gen(function* () {
    expect(yield* parseTranslationsJson('{"a":1}')).toBeNull();
  }),
);

it.effect("rejects arrays with non-string members", () =>
  Effect.gen(function* () {
    expect(yield* parseTranslationsJson('["你好", 2]')).toBeNull();
  }),
);

it.effect("rejects prose instead of JSON", () =>
  Effect.gen(function* () {
    expect(yield* parseTranslationsJson("抱歉，无法翻译")).toBeNull();
  }),
);

it("keeps a short text as a single chunk", () => {
  expect(chunkText("hello world", 2_000)).toEqual({ chunks: ["hello world"], separators: [] });
});

it("splits at paragraph boundaries and reassembles losslessly", () => {
  const paragraphs = ["a".repeat(900), "b".repeat(900), "c".repeat(900), "d".repeat(900)];
  const text = paragraphs.join("\n\n");
  const { chunks, separators } = chunkText(text, 2_000);
  // 900*2 + separator = 1802 fits; a third paragraph would exceed 2000.
  expect(chunks).toEqual([paragraphs.slice(0, 2).join("\n\n"), paragraphs.slice(2).join("\n\n")]);
  expect(separators).toEqual(["\n\n"]);
  expect(joinChunks(chunks, separators)).toBe(text);
});

it("falls back to line splitting inside an oversized paragraph and keeps single newlines", () => {
  const lines = ["x".repeat(1_200), "y".repeat(1_200), "z".repeat(1_200)];
  const text = lines.join("\n");
  const { chunks, separators } = chunkText(text, 2_000);
  expect(chunks).toEqual(lines);
  expect(separators).toEqual(["\n", "\n"]);
  expect(joinChunks(chunks, separators)).toBe(text);
});

it("records the paragraph break before an oversized paragraph's line chunks", () => {
  const intro = "i".repeat(1_500);
  const lines = ["x".repeat(1_500), "y".repeat(1_500)];
  const text = `${intro}\n\n${lines.join("\n")}`;
  const { chunks, separators } = chunkText(text, 2_000);
  expect(chunks).toEqual([intro, ...lines]);
  expect(separators).toEqual(["\n\n", "\n"]);
  expect(joinChunks(chunks, separators)).toBe(text);
});

it("never splits inside a single overlong line", () => {
  const text = "q".repeat(5_000);
  expect(chunkText(text, 2_000)).toEqual({ chunks: [text], separators: [] });
});

it("packs adjacent paragraphs together up to the target length", () => {
  const paragraphs = [
    "a".repeat(600),
    "b".repeat(600),
    "c".repeat(600),
    "d".repeat(600),
    "e".repeat(600),
  ];
  const text = paragraphs.join("\n\n");
  // 600*3 + two separators = 1804 fits; adding a fourth would exceed 2000.
  expect(chunkText(text, 2_000)).toEqual({
    chunks: [paragraphs.slice(0, 3).join("\n\n"), paragraphs.slice(3).join("\n\n")],
    separators: ["\n\n"],
  });
});
