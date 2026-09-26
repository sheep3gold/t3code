import { ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "./Migrations.ts";
import * as AgentMemories from "./AgentMemories.ts";

const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });
const testLayer = Layer.mergeAll(sqlite, AgentMemories.layer.pipe(Layer.provide(sqlite)));
const layer = it.layer(testLayer);

layer("AgentMemoryRepository", (it) => {
  it.effect("shares global lessons, scopes project memories, and de-duplicates fingerprints", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 57 });
      const repository = yield* AgentMemories.AgentMemoryRepository;
      const firstProject = ProjectId.make("project-1");
      const secondProject = ProjectId.make("project-2");
      const sourceThreadId = ThreadId.make("thread-1");
      const base = {
        kind: "lesson" as const,
        content: "Run focused tests",
        negative: null,
        tags: ["validation"],
        sourceThreadId,
        now: "2026-09-26T12:00:00.000Z",
      };
      const global = yield* repository.upsert({
        ...base,
        id: "global-1",
        fingerprint: "global-fingerprint",
        scope: "global",
        projectId: null,
      });
      yield* repository.upsert({
        ...base,
        id: "project-memory",
        fingerprint: "project-fingerprint",
        kind: "memory",
        scope: "project",
        projectId: firstProject,
      });
      const deduped = yield* repository.upsert({
        ...base,
        id: "global-duplicate",
        fingerprint: "global-fingerprint",
        scope: "global",
        projectId: null,
        now: "2026-09-26T12:01:00.000Z",
      });
      assert.equal(deduped.id, global.id);
      assert.deepStrictEqual(
        (yield* repository.candidates(secondProject)).map((entry) => entry.id),
        [global.id],
      );
      assert.equal(yield* repository.remove(global.id, secondProject), true);
      assert.equal((yield* repository.candidates(firstProject)).length, 1);
    }),
  );
});
