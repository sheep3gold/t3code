import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runMigrations } from "../../persistence/Migrations.ts";
import { runForkMigrations } from "../persistence/ForkMigrations.ts";
import * as ThreadLedger from "../ledger/ThreadLedger.ts";
import * as AgentMemories from "../memory/AgentMemories.ts";
import * as ForkTurnContext from "./ForkTurnContext.ts";

const layerDatabase = NodeSqliteClient.layer({ filename: ":memory:" });
const layerRepository = Layer.mergeAll(AgentMemories.layer, ThreadLedger.layer).pipe(
  Layer.provideMerge(layerDatabase),
);
const layerContext = ForkTurnContext.layer.pipe(Layer.provideMerge(layerRepository));

it.effect("prepends saved lessons for the thread's project", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* runForkMigrations();
    const projectId = ProjectId.make("project-1");
    yield* (yield* AgentMemories.AgentMemoryRepository).upsert({
      id: "lesson-1",
      fingerprint: "f-1",
      kind: "lesson",
      scope: "project",
      projectId,
      content: "Branch before editing.",
      negative: "Pushing to main.",
      tags: [],
      sourceThreadId: ThreadId.make("thread-0"),
      now: "2026-10-18T00:00:00.000Z",
    });
    const context = yield* (yield* ForkTurnContext.ForkTurnContext).read({
      threadId: ThreadId.make("thread-1"),
      projectId,
      userText: "hi",
    });
    assert.strictEqual(
      context,
      [
        "[Saved lessons — reusable behavior for this environment/project]",
        "- Branch before editing.",
        "  Avoid: Pushing to main.",
        "[End saved lessons]",
      ].join("\n"),
    );
  }).pipe(Effect.provide(layerContext)),
);
