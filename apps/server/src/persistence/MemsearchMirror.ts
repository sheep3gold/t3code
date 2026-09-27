import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import type { AgentMemory } from "./AgentMemories.ts";

const NAMESPACE = "t3code";
// RRF 归一化后单路命中第一名恰好是 0.5，门槛不能高于它，否则整类正确结果都会被滤掉
const MIN_SEMANTIC_SCORE = 0.45;
const SEARCH_TOP_K = 30;

const SearchResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({ score: Schema.Finite, source: Schema.String }),
  ),
});

const MEMORY_ID_FROM_SOURCE = new RegExp(`/${NAMESPACE}/([A-Za-z0-9_-]+)\\.md$`);

function config(): { readonly url: string; readonly apiKey: string } | null {
  const url = process.env.T3CODE_MEMSEARCH_URL?.trim().replace(/\/+$/, "");
  const apiKey = process.env.T3CODE_MEMSEARCH_API_KEY?.trim();
  return url && apiKey ? { url, apiKey } : null;
}

const execute = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* HttpClientResponse.filterStatusOk(yield* client.execute(request));
  }).pipe(Effect.provide(FetchHttpClient.layer));

function renderMemory(memory: AgentMemory): string {
  return [
    memory.content,
    ...(memory.negative ? [`\nAvoid: ${memory.negative}`] : []),
    ...(memory.tags.length > 0 ? [`\nTags: ${memory.tags.join(", ")}`] : []),
  ].join("\n");
}

function detached(
  operation: string,
  build: (url: string) => HttpClientRequest.HttpClientRequest,
): Effect.Effect<void> {
  const cfg = config();
  if (cfg === null) return Effect.void;
  return execute(build(cfg.url).pipe(HttpClientRequest.bearerToken(cfg.apiKey))).pipe(
    Effect.timeout("60 seconds"),
    Effect.tapError((cause) =>
      Effect.logWarning(`memsearch ${operation} failed; keyword search still works`, cause),
    ),
    Effect.ignoreCause({ log: false }),
    Effect.forkDetach,
    Effect.asVoid,
  );
}

export const mirrorPut = (memory: AgentMemory): Effect.Effect<void> =>
  detached("put", (url) =>
    HttpClientRequest.put(`${url}/v1/memories/${NAMESPACE}/${memory.id}`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        namespace: NAMESPACE,
        title: memory.content.slice(0, 80),
        content: renderMemory(memory),
        metadata: {
          kind: memory.kind,
          scope: memory.scope,
          project_id: memory.projectId ?? "global",
        },
      }),
    ),
  );

export const mirrorDelete = (id: string): Effect.Effect<void> =>
  detached("delete", (url) =>
    HttpClientRequest.delete(`${url}/v1/memories/${NAMESPACE}/${id}`),
  );

/** Memory ids ranked by semantic relevance, or null when memsearch is unconfigured or unreachable. */
export const semanticMemoryIds = (
  query: string,
): Effect.Effect<ReadonlyArray<string> | null> => {
  const cfg = config();
  if (cfg === null) return Effect.succeed(null);
  return execute(
    HttpClientRequest.post(`${cfg.url}/v1/search`).pipe(
      HttpClientRequest.bearerToken(cfg.apiKey),
      HttpClientRequest.bodyJsonUnsafe({
        query,
        top_k: SEARCH_TOP_K,
        namespace: NAMESPACE,
        max_content: 1,
      }),
    ),
  ).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(SearchResponse)),
    Effect.timeout("8 seconds"),
    Effect.map(({ results }): ReadonlyArray<string> | null => {
      const ids = results.flatMap((result) => {
        if (result.score < MIN_SEMANTIC_SCORE) return [];
        const id = MEMORY_ID_FROM_SOURCE.exec(result.source)?.[1];
        return id ? [id] : [];
      });
      return [...new Set(ids)];
    }),
    Effect.tapError((cause) =>
      Effect.logWarning("memsearch search failed; falling back to keyword search", cause),
    ),
    Effect.orElseSucceed(() => null),
  );
};
