import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError } from "./Errors.ts";
import * as MemsearchMirror from "./MemsearchMirror.ts";

export type AgentMemoryKind = "lesson" | "memory";
export type AgentMemoryScope = "global" | "project";

export interface AgentMemory {
  readonly id: string;
  readonly kind: AgentMemoryKind;
  readonly scope: AgentMemoryScope;
  readonly projectId: ProjectId | null;
  readonly content: string;
  readonly negative: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly sourceThreadId: ThreadId;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AgentMemoryRow {
  readonly id: string;
  readonly kind: AgentMemoryKind;
  readonly scope: AgentMemoryScope;
  readonly projectId: string | null;
  readonly content: string;
  readonly negative: string | null;
  readonly tagsJson: string;
  readonly sourceThreadId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertAgentMemoryInput {
  readonly id: string;
  readonly fingerprint: string;
  readonly kind: AgentMemoryKind;
  readonly scope: AgentMemoryScope;
  readonly projectId: ProjectId | null;
  readonly content: string;
  readonly negative: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly sourceThreadId: ThreadId;
  readonly now: string;
}

function parseTags(value: string): ReadonlyArray<string> {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

function fromRow(row: AgentMemoryRow): AgentMemory {
  return {
    ...row,
    projectId: row.projectId === null ? null : ProjectId.make(row.projectId),
    tags: parseTags(row.tagsJson),
    sourceThreadId: ThreadId.make(row.sourceThreadId),
  };
}

const sqlError = (operation: string) => (cause: unknown) =>
  new PersistenceSqlError({ operation, cause });

export class AgentMemoryRepository extends Context.Service<
  AgentMemoryRepository,
  {
    readonly upsert: (
      input: UpsertAgentMemoryInput,
    ) => Effect.Effect<AgentMemory, PersistenceSqlError>;
    readonly candidates: (
      projectId: ProjectId,
      kind?: AgentMemoryKind,
    ) => Effect.Effect<ReadonlyArray<AgentMemory>, PersistenceSqlError>;
    readonly get: (
      id: string,
      projectId: ProjectId,
    ) => Effect.Effect<AgentMemory | null, PersistenceSqlError>;
    readonly update: (input: {
      readonly id: string;
      readonly projectId: ProjectId;
      readonly fingerprint: string;
      readonly content: string;
      readonly negative: string | null;
      readonly tags: ReadonlyArray<string>;
      readonly now: string;
    }) => Effect.Effect<AgentMemory | null, PersistenceSqlError>;
    readonly recentLessons: (
      projectId: ProjectId,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<AgentMemory>, PersistenceSqlError>;
    readonly remove: (
      id: string,
      projectId: ProjectId,
    ) => Effect.Effect<boolean, PersistenceSqlError>;
  }
>()("t3/persistence/AgentMemoryRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return AgentMemoryRepository.of({
    upsert: (input) =>
      Effect.gen(function* () {
        const rows = yield* sql<AgentMemoryRow>`
          INSERT INTO agent_memories (
            id, fingerprint, kind, scope, project_id, content, negative,
            tags_json, source_thread_id, created_at, updated_at
          ) VALUES (
            ${input.id}, ${input.fingerprint}, ${input.kind}, ${input.scope},
            ${input.projectId}, ${input.content}, ${input.negative}, ${JSON.stringify(input.tags)},
            ${input.sourceThreadId}, ${input.now}, ${input.now}
          )
          ON CONFLICT (fingerprint)
          DO UPDATE SET
            content = excluded.content,
            negative = excluded.negative,
            tags_json = excluded.tags_json,
            updated_at = excluded.updated_at
          RETURNING
            id,
            kind,
            scope,
            project_id AS "projectId",
            content,
            negative,
            tags_json AS "tagsJson",
            source_thread_id AS "sourceThreadId",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `;
        return fromRow(rows[0]!);
      }).pipe(Effect.mapError(sqlError("upsertAgentMemory")), Effect.tap(MemsearchMirror.mirrorPut)),

    candidates: (projectId, kind) =>
      (kind === undefined
        ? sql<AgentMemoryRow>`
            SELECT
              id, kind, scope, project_id AS "projectId", content, negative,
              tags_json AS "tagsJson", source_thread_id AS "sourceThreadId",
              created_at AS "createdAt", updated_at AS "updatedAt"
            FROM agent_memories
            WHERE scope = 'global' OR (scope = 'project' AND project_id = ${projectId})
            ORDER BY updated_at DESC
            LIMIT 500
          `
        : sql<AgentMemoryRow>`
            SELECT
              id, kind, scope, project_id AS "projectId", content, negative,
              tags_json AS "tagsJson", source_thread_id AS "sourceThreadId",
              created_at AS "createdAt", updated_at AS "updatedAt"
            FROM agent_memories
            WHERE kind = ${kind}
              AND (scope = 'global' OR (scope = 'project' AND project_id = ${projectId}))
            ORDER BY updated_at DESC
            LIMIT 500
          `
      ).pipe(
        Effect.map((rows) => rows.map(fromRow)),
        Effect.mapError(sqlError("listAgentMemoryCandidates")),
      ),

    get: (id, projectId) =>
      sql<AgentMemoryRow>`
        SELECT
          id, kind, scope, project_id AS "projectId", content, negative,
          tags_json AS "tagsJson", source_thread_id AS "sourceThreadId",
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM agent_memories
        WHERE id = ${id}
          AND (scope = 'global' OR (scope = 'project' AND project_id = ${projectId}))
        LIMIT 1
      `.pipe(
        Effect.map((rows) => (rows[0] ? fromRow(rows[0]) : null)),
        Effect.mapError(sqlError("getAgentMemory")),
      ),

    update: (input) =>
      sql<AgentMemoryRow>`
        UPDATE agent_memories
        SET fingerprint = ${input.fingerprint},
            content = ${input.content},
            negative = ${input.negative},
            tags_json = ${JSON.stringify(input.tags)},
            updated_at = ${input.now}
        WHERE id = ${input.id}
          AND (scope = 'global' OR (scope = 'project' AND project_id = ${input.projectId}))
        RETURNING
          id, kind, scope, project_id AS "projectId", content, negative,
          tags_json AS "tagsJson", source_thread_id AS "sourceThreadId",
          created_at AS "createdAt", updated_at AS "updatedAt"
      `.pipe(
        Effect.map((rows) => (rows[0] ? fromRow(rows[0]) : null)),
        Effect.mapError(sqlError("updateAgentMemory")),
        Effect.tap((memory) => (memory ? MemsearchMirror.mirrorPut(memory) : Effect.void)),
      ),

    recentLessons: (projectId, limit = 20) =>
      sql<AgentMemoryRow>`
        SELECT
          id, kind, scope, project_id AS "projectId", content, negative,
          tags_json AS "tagsJson", source_thread_id AS "sourceThreadId",
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM agent_memories
        WHERE kind = 'lesson'
          AND (scope = 'global' OR (scope = 'project' AND project_id = ${projectId}))
        ORDER BY updated_at DESC
        LIMIT ${Math.max(1, Math.min(50, limit))}
      `.pipe(
        Effect.map((rows) => rows.map(fromRow)),
        Effect.mapError(sqlError("listRecentAgentLessons")),
      ),

    remove: (id, projectId) =>
      sql`
        DELETE FROM agent_memories
        WHERE id = ${id}
          AND (scope = 'global' OR (scope = 'project' AND project_id = ${projectId}))
        RETURNING id
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(sqlError("removeAgentMemory")),
        Effect.tap((removed) => (removed ? MemsearchMirror.mirrorDelete(id) : Effect.void)),
      ),
  });
});

export const layer = Layer.effect(AgentMemoryRepository, make);
