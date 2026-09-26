import * as NodeCrypto from "node:crypto";

import { ProjectId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as AgentMemories from "../persistence/AgentMemories.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

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

const AddMemoryInput = Schema.Struct({
  kind: Schema.Literals(["lesson", "memory"]),
  scope: Schema.Literals(["global", "project"]),
  content: TrimmedNonEmptyString,
  negative: Schema.optional(Schema.NullOr(Schema.String)),
  tags: Schema.optional(Schema.Array(Schema.String)),
});

const SearchMemoryInput = Schema.Struct({
  query: TrimmedNonEmptyString,
  kind: Schema.optional(Schema.Literals(["lesson", "memory"])),
  limit: Schema.optional(Schema.Int),
});

const RemoveMemoryInput = Schema.Struct({ id: TrimmedNonEmptyString });

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
  AgentMemoryInputInvalidError,
  AgentMemoryThreadNotFoundError,
  AgentMemoryOperationError,
]);

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  AgentMemories.AgentMemoryRepository,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  Crypto.Crypto,
  Clock.Clock,
];

const AddMemoryTool = Tool.make("memory_add", {
  description:
    "Explicitly save a reusable lesson or memory for later threads. Lessons are automatically injected into later turns in scope; ordinary memories are returned only by memory_search. Use project scope unless the fact truly applies across every project in this environment. Never save credentials, source code, or chat transcripts.",
  parameters: AddMemoryInput,
  success: MemoryEntry,
  failure: AgentMemoryToolError,
  dependencies,
})
  .annotate(Tool.Title, "Add agent memory")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SearchMemoryTool = Tool.make("memory_search", {
  description:
    "Search explicit memories and lessons visible to this project. Results come from local deterministic keyword scoring; no project content is sent to an embedding service.",
  parameters: SearchMemoryInput,
  success: Schema.Struct({ memories: Schema.Array(MemoryEntry) }),
  failure: AgentMemoryToolError,
  dependencies,
})
  .annotate(Tool.Title, "Search agent memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RemoveMemoryTool = Tool.make("memory_remove", {
  description: "Permanently remove one explicit memory by id from this project or global scope.",
  parameters: RemoveMemoryInput,
  success: Schema.Struct({ removed: Schema.Boolean }),
  failure: AgentMemoryToolError,
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
  const normalized = [...new Set((tags ?? []).map((tag) => clip(tag, MAX_TAG_CHARS)).filter(Boolean))];
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

export function formatAgentLessonContext(
  lessons: ReadonlyArray<AgentMemories.AgentMemory>,
): string {
  if (lessons.length === 0) return "";
  const lines = [
    "[Saved lessons — reusable behavior for this environment/project]",
    ...lessons.map((lesson) =>
      [
        `- ${lesson.content}`,
        ...(lesson.negative ? [`  Avoid: ${lesson.negative}`] : []),
      ].join("\n"),
    ),
    "[End saved lessons]",
  ];
  return Array.from(lines.join("\n")).slice(0, MAX_LESSON_CONTEXT_CHARS).join("");
}

const make = Effect.gen(function* () {
  const repository = yield* AgentMemories.AgentMemoryRepository;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const scopeContext = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const thread = yield* snapshots
      .getThreadShellById(scope.threadId)
      .pipe(
        Effect.mapError(
          (cause) => new AgentMemoryOperationError({ operation: "read-thread", cause }),
        ),
        Effect.map(Option.getOrUndefined),
      );
    if (!thread || thread.archivedAt !== null || thread.deletedAt !== null) {
      return yield* new AgentMemoryThreadNotFoundError({ threadId: scope.threadId });
    }
    return { scope, projectId: thread.projectId };
  });

  return AgentMemoryToolkit.of({
    memory_add: (input) =>
      Effect.gen(function* () {
        const context = yield* scopeContext;
        const content = clip(input.content, MAX_CONTENT_CHARS);
        const negative = input.negative === null || input.negative === undefined
          ? null
          : clip(input.negative, MAX_NEGATIVE_CHARS);
        const tags = normalizeTags(input.tags);
        if (!content || tags === null) {
          return yield* new AgentMemoryInputInvalidError({
            detail: `content is required and tags are limited to ${MAX_TAGS}.`,
          });
        }
        const projectId = input.scope === "project" ? context.projectId : null;
        const fingerprint = NodeCrypto.createHash("sha256")
          .update(`${input.kind}|${input.scope}|${projectId ?? ""}|${content}`)
          .digest("hex");
        const now = new Date(yield* Clock.currentTimeMillis).toISOString();
        return yield* repository
          .upsert({
            id: yield* crypto.randomUUIDv4,
            fingerprint,
            kind: input.kind,
            scope: input.scope,
            projectId,
            content,
            negative,
            tags,
            sourceThreadId: context.scope.threadId,
            now,
          })
          .pipe(
            Effect.mapError(
              (cause) => new AgentMemoryOperationError({ operation: "add", cause }),
            ),
          );
      }),
    memory_search: (input) =>
      Effect.gen(function* () {
        const context = yield* scopeContext;
        const candidates = yield* repository
          .candidates(context.projectId, input.kind)
          .pipe(
            Effect.mapError(
              (cause) => new AgentMemoryOperationError({ operation: "search", cause }),
            ),
          );
        return {
          memories: searchAgentMemories(candidates, input.query, input.limit ?? 10),
        };
      }),
    memory_remove: ({ id }) =>
      Effect.gen(function* () {
        const context = yield* scopeContext;
        const removed = yield* repository
          .remove(id, context.projectId)
          .pipe(
            Effect.mapError(
              (cause) => new AgentMemoryOperationError({ operation: "remove", cause }),
            ),
          );
        return { removed };
      }),
  });
});

export const AgentMemoryToolkitHandlersLive = AgentMemoryToolkit.toLayer(make);

export const readAgentLessonContext = Effect.fn("AgentMemory.readLessonContext")(function* (
  projectId: ProjectId,
) {
  const repository = yield* AgentMemories.AgentMemoryRepository;
  const lessons = yield* repository.recentLessons(projectId, 20);
  return formatAgentLessonContext(lessons);
});
