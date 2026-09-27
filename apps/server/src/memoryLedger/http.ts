import * as NodeCrypto from "node:crypto";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { rankAgentMemories } from "../orchestration/AgentMemory.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as AgentMemories from "../persistence/AgentMemories.ts";
import * as ThreadLedger from "../persistence/ThreadLedger.ts";

const MAX_CONTENT_CHARS = 2_000;
const MAX_NEGATIVE_CHARS = 1_000;
const MAX_TAGS = 10;
const MAX_TAG_CHARS = 80;
const MAX_LEDGER_FIELD_CHARS = 2_000;
const MAX_ARTIFACTS = 32;

const clip = (value: string, limit: number) => Array.from(value.trim()).slice(0, limit).join("");

function normalizeMemory(input: {
  readonly content: string;
  readonly negative?: string | null | undefined;
  readonly tags?: ReadonlyArray<string> | undefined;
}) {
  const content = clip(input.content, MAX_CONTENT_CHARS);
  const negative = input.negative ? clip(input.negative, MAX_NEGATIVE_CHARS) : null;
  const tags = [
    ...new Set((input.tags ?? []).map((tag) => clip(tag, MAX_TAG_CHARS)).filter(Boolean)),
  ];
  return !content || tags.length > MAX_TAGS ? null : { content, negative, tags };
}

function fingerprint(memory: {
  readonly kind: AgentMemories.AgentMemoryKind;
  readonly scope: AgentMemories.AgentMemoryScope;
  readonly projectId: ProjectId | null;
  readonly content: string;
}) {
  return NodeCrypto.createHash("sha256")
    .update(`${memory.kind}|${memory.scope}|${memory.projectId ?? ""}|${memory.content}`)
    .digest("hex");
}

function normalizeLedger(input: {
  readonly goal: string | null;
  readonly phase: string | null;
  readonly next: string | null;
  readonly artifacts: Readonly<Record<string, string>>;
}) {
  if (Object.keys(input.artifacts).length > MAX_ARTIFACTS) return null;
  const artifacts: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.artifacts)) {
    const normalizedKey = clip(key, MAX_LEDGER_FIELD_CHARS);
    const normalizedValue = clip(value, MAX_LEDGER_FIELD_CHARS);
    if (!normalizedKey || !normalizedValue) return null;
    artifacts[normalizedKey] = normalizedValue;
  }
  const nullable = (value: string | null) =>
    value === null ? null : clip(value, MAX_LEDGER_FIELD_CHARS) || null;
  return {
    goal: nullable(input.goal),
    phase: nullable(input.phase),
    next: nullable(input.next),
    artifacts,
  };
}

export const memoryLedgerHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "memoryLedger",
  Effect.fnUntraced(function* (handlers) {
    const memories = yield* AgentMemories.AgentMemoryRepository;
    const ledgers = yield* ThreadLedger.ThreadLedgerRepository;
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const internal = (cause: unknown) => failEnvironmentInternal("internal_error", cause);
    const readScope = (endpoint: string) =>
      annotateEnvironmentRequest(endpoint).pipe(
        Effect.andThen(requireEnvironmentScope(AuthOrchestrationReadScope)),
      );
    const operateScope = (endpoint: string) =>
      annotateEnvironmentRequest(endpoint).pipe(
        Effect.andThen(requireEnvironmentScope(AuthOrchestrationOperateScope)),
      );
    const requireThread = (threadId: ThreadId, projectId: ProjectId) =>
      snapshots.getThreadShellById(threadId).pipe(
        Effect.catch(internal),
        Effect.flatMap(
          Option.match({
            onNone: () => failEnvironmentNotFound("thread_not_found"),
            onSome: (thread) =>
              thread.projectId === projectId
                ? Effect.succeed(thread)
                : failEnvironmentNotFound("thread_not_found"),
          }),
        ),
      );

    return handlers
      .handle(
        "listMemories",
        Effect.fn("environment.memories.list")(function* (args) {
          yield* readScope(args.endpoint.name);
          const candidates = yield* memories
            .candidates(args.payload.projectId, args.payload.kind)
            .pipe(Effect.catch(internal));
          return {
            memories: args.payload.query?.trim()
              ? yield* rankAgentMemories(candidates, args.payload.query, 100)
              : candidates,
          };
        }),
      )
      .handle(
        "createMemory",
        Effect.fn("environment.memories.create")(function* (args) {
          yield* operateScope(args.endpoint.name);
          yield* requireThread(args.payload.sourceThreadId, args.payload.projectId);
          const normalized = normalizeMemory(args.payload);
          if (normalized === null) return yield* failEnvironmentInvalidRequest("invalid_memory");
          const projectId = args.payload.scope === "project" ? args.payload.projectId : null;
          const now = DateTime.formatIso(yield* DateTime.now);
          return yield* memories
            .upsert({
              id: NodeCrypto.randomUUID(),
              fingerprint: fingerprint({
                kind: args.payload.kind,
                scope: args.payload.scope,
                projectId,
                content: normalized.content,
              }),
              kind: args.payload.kind,
              scope: args.payload.scope,
              projectId,
              ...normalized,
              sourceThreadId: args.payload.sourceThreadId,
              now,
            })
            .pipe(Effect.catch(internal));
        }),
      )
      .handle(
        "updateMemory",
        Effect.fn("environment.memories.update")(function* (args) {
          yield* operateScope(args.endpoint.name);
          const existing = yield* memories
            .get(args.params.memoryId, args.payload.projectId)
            .pipe(Effect.catch(internal));
          if (existing === null) return yield* failEnvironmentNotFound("memory_not_found");
          const normalized = normalizeMemory(args.payload);
          if (normalized === null) return yield* failEnvironmentInvalidRequest("invalid_memory");
          const updated = yield* memories
            .update({
              id: existing.id,
              projectId: args.payload.projectId,
              fingerprint: fingerprint({ ...existing, content: normalized.content }),
              ...normalized,
              now: DateTime.formatIso(yield* DateTime.now),
            })
            .pipe(Effect.catch(internal));
          return updated ?? (yield* failEnvironmentNotFound("memory_not_found"));
        }),
      )
      .handle(
        "removeMemory",
        Effect.fn("environment.memories.remove")(function* (args) {
          yield* operateScope(args.endpoint.name);
          return {
            removed: yield* memories
              .remove(args.params.memoryId, args.payload.projectId)
              .pipe(Effect.catch(internal)),
          };
        }),
      )
      .handle(
        "getLedger",
        Effect.fn("environment.ledgers.get")(function* (args) {
          yield* readScope(args.endpoint.name);
          yield* requireThread(args.params.threadId, args.payload.projectId);
          return yield* ledgers.read(args.params.threadId, 100).pipe(Effect.catch(internal));
        }),
      )
      .handle(
        "updateLedger",
        Effect.fn("environment.ledgers.update")(function* (args) {
          yield* operateScope(args.endpoint.name);
          yield* requireThread(args.params.threadId, args.payload.projectId);
          const state = normalizeLedger(args.payload);
          const hasOneEvent =
            args.payload.event !== undefined || args.payload.eventKind !== undefined;
          const current = yield* ledgers.read(args.params.threadId, 1).pipe(Effect.catch(internal));
          const phaseChanged = state?.phase !== (current.state?.phase ?? null);
          if (
            state === null ||
            (hasOneEvent &&
              (args.payload.event === undefined || args.payload.eventKind === undefined)) ||
            (phaseChanged && !hasOneEvent)
          ) {
            return yield* failEnvironmentInvalidRequest("invalid_ledger");
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          return yield* ledgers
            .record({
              threadId: args.params.threadId,
              state,
              updatedAt: now,
              ...(args.payload.event !== undefined && args.payload.eventKind !== undefined
                ? {
                    event: {
                      kind: clip(args.payload.eventKind, MAX_LEDGER_FIELD_CHARS),
                      message: clip(args.payload.event, MAX_LEDGER_FIELD_CHARS),
                    },
                  }
                : {}),
            })
            .pipe(Effect.catch(internal));
        }),
      )
      .handle(
        "clearLedger",
        Effect.fn("environment.ledgers.clear")(function* (args) {
          yield* operateScope(args.endpoint.name);
          yield* requireThread(args.params.threadId, args.payload.projectId);
          return {
            cleared: yield* ledgers.clear(args.params.threadId).pipe(Effect.catch(internal)),
          };
        }),
      );
  }),
);
