import {
  OrchestratorMcpFailure,
  type ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as AgentMemories from "./AgentMemories.ts";
import * as MemsearchMirror from "./MemsearchMirror.ts";

const MAX_CONTENT_CHARS = 2_000;
const MAX_NEGATIVE_CHARS = 1_000;
const MAX_TAGS = 10;
const MAX_TAG_CHARS = 80;
const MAX_LESSON_CONTEXT_CHARS = 6_000;

const MemoryEntry = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["lesson", "memory"]),
  scope: Schema.Literals(["global", "project"]),
  projectId: Schema.NullOr(Schema.String),
  content: Schema.String,
  negative: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  sourceThreadId: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export class AgentMemoryInputInvalidError extends Schema.TaggedError<AgentMemoryInputInvalidError>()(
  "AgentMemoryInputInvalidError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class AgentMemoryThreadNotFoundError extends Schema.TaggedError<AgentMemoryThreadNotFoundError>()(
  "AgentMemoryThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class AgentMemoryOperationError extends Schema.TaggedError<AgentMemoryOperationError>()(
  "AgentMemoryOperationError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Memory operation '${this.operation}' failed.`;
  }
}

const AgentMemoryToolError = Schema.Union([
  OrchestratorMcpFailure,
  AgentMemoryInputInvalidError,
  AgentMemoryThreadNotFoundError,
  AgentMemoryOperationError,
]);

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  AgentMemories.AgentMemoryRepository,
  ProjectionStore.ProjectionStoreV2,
  ThreadManagementService.ThreadManagementService,
  Crypto.Crypto,
];

const AddMemoryTool = Tool.make("memory_add", {
  description:
    "Explicitly save a reusable lesson or memory for later threads. Lessons are automatically injected into later turns in scope; ordinary memories are returned only by memory_search. Use project scope unless the fact truly applies across every project in this environment. When memsearch is configured, saved entries are mirrored to it for semantic search. Never save credentials, source code, or chat transcripts.",
  parameters: Schema.Struct({
    kind: Schema.Literals(["lesson", "memory"]),
    scope: Schema.Literals(["global", "project"]),
    content: TrimmedNonEmptyString,
    negative: Schema.optional(Schema.NullOr(Schema.String)),
    tags: Schema.optional(Schema.Array(Schema.String)),
  }),
  success: MemoryEntry,
  failure: AgentMemoryToolError,
  failureMode: "return" as const,
  dependencies,
})
  .annotate(Tool.Title, "Add agent memory")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SearchMemoryTool = Tool.make("memory_search", {
  description:
    "Search explicit memories and lessons visible to this project. Uses semantic search through the configured memsearch service when available, merged with local keyword scoring as a fallback.",
  parameters: Schema.Struct({
    query: TrimmedNonEmptyString,
    kind: Schema.optional(Schema.Literals(["lesson", "memory"])),
    limit: Schema.optional(Schema.Int),
  }),
  success: Schema.Struct({ memories: Schema.Array(MemoryEntry) }),
  failure: AgentMemoryToolError,
  failureMode: "return" as const,
  dependencies,
})
  .annotate(Tool.Title, "Search agent memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RemoveMemoryTool = Tool.make("memory_remove", {
  description: "Permanently remove one explicit memory by id from this project or global scope.",
  parameters: Schema.Struct({ id: TrimmedNonEmptyString }),
  success: Schema.Struct({ removed: Schema.Boolean }),
  failure: AgentMemoryToolError,
  failureMode: "return" as const,
  dependencies,
})
  .annotate(Tool.Title, "Remove agent memory")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const AgentMemoryToolkit = Toolkit.make(AddMemoryTool, SearchMemoryTool, RemoveMemoryTool);

function clip(value: string, limit: number): string {
  return Array.from(value.trim()).slice(0, limit).join("");
}

function normalizeTags(tags: ReadonlyArray<string> | undefined): ReadonlyArray<string> | null {
  if ((tags?.length ?? 0) > MAX_TAGS) return null;
  const normalized = [
    ...new Set((tags ?? []).map((tag) => clip(tag, MAX_TAG_CHARS)).filter(Boolean)),
  ];
  return normalized.length <= MAX_TAGS ? normalized : null;
}

function words(value: string): ReadonlyArray<string> {
  return value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

export function searchAgentMemories(
  candidates: ReadonlyArray<AgentMemories.AgentMemory>,
  query: string,
  limit: number,
): ReadonlyArray<AgentMemories.AgentMemory> {
  const normalizedQuery = query.trim().toLowerCase();
  const queryWords = [...new Set(words(normalizedQuery))];
  return candidates
    .map((memory, index) => {
      const haystack = [memory.content, memory.negative ?? "", ...memory.tags]
        .join(" ")
        .toLowerCase();
      const score =
        (haystack.includes(normalizedQuery) ? 100 : 0) +
        queryWords.reduce((sum, word) => sum + (haystack.includes(word) ? 10 : 0), 0);
      return { memory, index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(1, Math.min(20, limit)))
    .map((entry) => entry.memory);
}

export const rankAgentMemories = Effect.fn("AgentMemory.rank")(function* (
  candidates: ReadonlyArray<AgentMemories.AgentMemory>,
  query: string,
  limit: number,
) {
  const keyword = searchAgentMemories(candidates, query, limit);
  const semanticIds = yield* MemsearchMirror.semanticMemoryIds(query);
  if (semanticIds === null) return keyword;
  const byId = new Map(candidates.map((memory) => [memory.id, memory]));
  const merged = [...semanticIds.flatMap((id) => byId.get(id) ?? []), ...keyword];
  return [...new Map(merged.map((memory) => [memory.id, memory])).values()].slice(
    0,
    Math.max(1, Math.min(20, limit)),
  );
});

export function formatAgentLessonContext(
  lessons: ReadonlyArray<AgentMemories.AgentMemory>,
): string {
  if (lessons.length === 0) return "";
  const lines = [
    "[Saved lessons — reusable behavior for this environment/project]",
    ...lessons.map((lesson) =>
      [`- ${lesson.content}`, ...(lesson.negative ? [`  Avoid: ${lesson.negative}`] : [])].join(
        "\n",
      ),
    ),
    "[End saved lessons]",
  ];
  return Array.from(lines.join("\n")).slice(0, MAX_LESSON_CONTEXT_CHARS).join("");
}

const callerContext = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threadScope = yield* McpInvocationContext.requireThreadScope(scope, "Agent memory");
  const threadId = ThreadId.make(threadScope.thread.threadId);
  const shell = yield* (yield* ProjectionStore.ProjectionStoreV2)
    .getThreadShell(threadId)
    .pipe(
      Effect.mapError(
        (cause) => new AgentMemoryOperationError({ operation: "read-thread", cause }),
      ),
    );
  if (shell === null || shell.archivedAt !== null || shell.deletedAt !== null) {
    return yield* new AgentMemoryThreadNotFoundError({ threadId });
  }
  return { threadId, projectId: shell.projectId };
});

const repositoryError = (operation: string) => (cause: unknown) =>
  new AgentMemoryOperationError({ operation, cause });

export const AgentMemoryHandlersLive = McpToolAccess.toLayer(AgentMemoryToolkit, {
  memory_add: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const context = yield* callerContext;
      const repository = yield* AgentMemories.AgentMemoryRepository;
      const crypto = yield* Crypto.Crypto;
      const content = clip(input.content, MAX_CONTENT_CHARS);
      const negative =
        input.negative === null || input.negative === undefined
          ? null
          : clip(input.negative, MAX_NEGATIVE_CHARS);
      const tags = normalizeTags(input.tags);
      if (!content || tags === null) {
        return yield* new AgentMemoryInputInvalidError({
          detail: `content is required and tags are limited to ${MAX_TAGS}.`,
        });
      }
      const projectId = input.scope === "project" ? context.projectId : null;
      const fingerprint = AgentMemories.memoryFingerprint({
        kind: input.kind,
        scope: input.scope,
        projectId,
        content,
      });
      return yield* repository
        .upsert({
          id: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
          fingerprint,
          kind: input.kind,
          scope: input.scope,
          projectId,
          content,
          negative,
          tags,
          sourceThreadId: context.threadId,
          now: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(Effect.mapError(repositoryError("add")));
    }),
  ),
  memory_search: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const context = yield* callerContext;
      const candidates = yield* (yield* AgentMemories.AgentMemoryRepository)
        .candidates(context.projectId, input.kind)
        .pipe(Effect.mapError(repositoryError("search")));
      return { memories: yield* rankAgentMemories(candidates, input.query, input.limit ?? 10) };
    }),
  ),
  memory_remove: McpToolAccess.actsAsCaller(({ id }) =>
    Effect.gen(function* () {
      const context = yield* callerContext;
      const removed = yield* (yield* AgentMemories.AgentMemoryRepository)
        .remove(id, context.projectId)
        .pipe(Effect.mapError(repositoryError("remove")));
      return { removed };
    }),
  ),
});

export const readAgentLessonContext = Effect.fn("AgentMemory.readLessonContext")(function* (
  projectId: ProjectId,
) {
  const repository = yield* AgentMemories.AgentMemoryRepository;
  return formatAgentLessonContext(yield* repository.recentLessons(projectId, 20));
});
