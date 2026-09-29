import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import type { AgentMemory } from "./AgentMemories.ts";

/**
 * Bridge to memory-api (memsearch-api `/v1/records`), which is the authority for memories.
 * The local `agent_memories` table is a cache plus offline fallback: writes go local first
 * and are pushed here; `MemorySync` pulls remote changes (including nightly consolidation
 * results) back into the cache.
 */

// RRF 归一化后单路命中第一名恰好是 0.5，门槛不能高于它，否则整类正确结果都会被滤掉
const MIN_SEMANTIC_SCORE = 0.45;
const SEARCH_TOP_K = 30;

export type MemoryAuthority = "user_stated" | "observed";

export const RemoteRecord = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  scope: Schema.String,
  project_id: Schema.NullOr(Schema.String),
  content: Schema.String,
  negative: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  status: Schema.String,
  updated_at: Schema.String,
  source_ref: Schema.optional(Schema.NullOr(Schema.String)),
});
export type RemoteRecord = typeof RemoteRecord.Type;

const ListResponse = Schema.Struct({
  records: Schema.Array(RemoteRecord),
  cursor: Schema.NullOr(Schema.String),
});

const SearchResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({ score: Schema.Finite, record: Schema.Struct({ id: Schema.String }) }),
  ),
});

const ContextResponse = Schema.Struct({ text: Schema.String });

function config(): { readonly url: string; readonly apiKey: string } | null {
  // 单测绝不能连生产：曾有测试数据（memory-1 / memory-slash）被写进 t3code 命名空间
  if (process.env.VITEST && process.env.T3CODE_MEMSEARCH_IN_TESTS !== "1") return null;
  const url = process.env.T3CODE_MEMSEARCH_URL?.trim().replace(/\/+$/, "");
  const apiKey = process.env.T3CODE_MEMSEARCH_API_KEY?.trim();
  return url && apiKey ? { url, apiKey } : null;
}

export const isConfigured = (): boolean => config() !== null;

const execute = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* HttpClientResponse.filterStatusOk(yield* client.execute(request));
  }).pipe(Effect.provide(FetchHttpClient.layer));

const authed = (cfg: { readonly apiKey: string }, request: HttpClientRequest.HttpClientRequest) =>
  request.pipe(HttpClientRequest.bearerToken(cfg.apiKey));

function detached(
  operation: string,
  build: (url: string) => HttpClientRequest.HttpClientRequest,
): Effect.Effect<void> {
  const cfg = config();
  if (cfg === null) return Effect.void;
  return execute(authed(cfg, build(cfg.url))).pipe(
    Effect.timeout("60 seconds"),
    Effect.tapError((cause) =>
      Effect.logWarning(`memory-api ${operation} failed; MemorySync will retry`, cause),
    ),
    Effect.ignoreCause({ log: false }),
    Effect.forkDetach,
    Effect.asVoid,
  );
}

export function recordBody(memory: AgentMemory, authority: MemoryAuthority) {
  return {
    kind: memory.kind,
    scope: memory.scope,
    project_id: memory.projectId,
    content: memory.content,
    negative: memory.negative,
    tags: memory.tags,
    authority,
    source_agent: "t3code",
    source_ref: `thread:${memory.sourceThreadId}`,
  };
}

export const pushRecordRequest = (url: string, memory: AgentMemory, authority: MemoryAuthority) =>
  HttpClientRequest.put(`${url}/v1/records/${memory.id}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(recordBody(memory, authority)),
  );

export const mirrorPut = (
  memory: AgentMemory,
  authority: MemoryAuthority = "observed",
): Effect.Effect<void> => detached("put", (url) => pushRecordRequest(url, memory, authority));

export const mirrorDelete = (id: string): Effect.Effect<void> =>
  detached("delete", (url) => HttpClientRequest.delete(`${url}/v1/records/${id}`));

/** Push one memory and wait for the result. Used by MemorySync to backfill. */
export const pushNow = (memory: AgentMemory): Effect.Effect<boolean> => {
  const cfg = config();
  if (cfg === null) return Effect.succeed(false);
  return execute(authed(cfg, pushRecordRequest(cfg.url, memory, "observed"))).pipe(
    Effect.timeout("30 seconds"),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
};

/** Remote changes since `cursor` (all statuses, so invalidations propagate). */
export const listRemoteChanges = (
  cursor: string | null,
): Effect.Effect<{ records: ReadonlyArray<RemoteRecord>; cursor: string | null } | null> => {
  const cfg = config();
  if (cfg === null) return Effect.succeed(null);
  const params = new URLSearchParams({ status: "all", limit: "5000" });
  if (cursor) params.set("since", cursor);
  return execute(
    authed(cfg, HttpClientRequest.get(`${cfg.url}/v1/records?${params.toString()}`)),
  ).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ListResponse)),
    Effect.timeout("30 seconds"),
    Effect.map((body) => ({ records: body.records, cursor: body.cursor })),
    Effect.tapError((cause) => Effect.logWarning("memory-api pull failed", cause)),
    Effect.orElseSucceed(() => null),
  );
};

/** Memory ids ranked by semantic relevance, or null when memory-api is unconfigured or unreachable. */
export const semanticMemoryIds = (query: string): Effect.Effect<ReadonlyArray<string> | null> => {
  const cfg = config();
  if (cfg === null) return Effect.succeed(null);
  return execute(
    authed(
      cfg,
      HttpClientRequest.post(`${cfg.url}/v1/records/search`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ query, top_k: SEARCH_TOP_K }),
      ),
    ),
  ).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(SearchResponse)),
    Effect.timeout("8 seconds"),
    Effect.map(({ results }): ReadonlyArray<string> | null => {
      const ids = results.flatMap((result) =>
        result.score === 0 || result.score >= MIN_SEMANTIC_SCORE ? [result.record.id] : [],
      );
      return [...new Set(ids)];
    }),
    Effect.tapError((cause) =>
      Effect.logWarning("memory-api search failed; falling back to keyword search", cause),
    ),
    Effect.orElseSucceed(() => null),
  );
};

/**
 * Facts relevant to this turn (rules/preferences are injected separately from the local
 * cache as lessons). Empty string when unconfigured, unreachable or slow — a turn must
 * never wait on memory.
 */
export const relevantFactsContext = (
  query: string,
  projectId: string | null,
): Effect.Effect<string> => {
  const cfg = config();
  if (cfg === null || query.trim().length < 4) return Effect.succeed("");
  return execute(
    authed(
      cfg,
      HttpClientRequest.post(`${cfg.url}/v1/context`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          query: query.slice(0, 2_000),
          project_id: projectId,
          include_core: false,
          fact_limit: 5,
        }),
      ),
    ),
  ).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ContextResponse)),
    Effect.timeout("4 seconds"),
    Effect.map((body) => body.text),
    Effect.tapError((cause) => Effect.logWarning("memory-api context failed", cause)),
    Effect.orElseSucceed(() => ""),
  );
};
