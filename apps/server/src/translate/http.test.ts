import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { parseTranslationsJson } from "./http.ts";

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
