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
      const projectMemory = (yield* repository.candidates(firstProject, "memory"))[0]!;
      assert.equal(yield* repository.get(projectMemory.id, secondProject), null);
      const updated = yield* repository.update({
        id: projectMemory.id,
        projectId: firstProject,
        fingerprint: "updated-project-fingerprint",
        content: "Prefer targeted validation",
        negative: "Do not run the full suite",
        tags: ["tests", "performance"],
        now: "2026-09-26T12:02:00.000Z",
      });
      assert.equal(updated?.content, "Prefer targeted validation");
      assert.deepStrictEqual(updated?.tags, ["tests", "performance"]);
      assert.deepStrictEqual(
        (yield* repository.candidates(secondProject)).map((entry) => entry.id),
        [global.id],
      );
      assert.equal(yield* repository.remove(global.id, secondProject), true);
      assert.equal((yield* repository.candidates(firstProject)).length, 1);
    }),
  );

  it.effect("applies memory-api changes to the cache and drops invalidated records", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 57 });
      const repository = yield* AgentMemories.AgentMemoryRepository;
      const project = ProjectId.make("project-1");
      const remote = (overrides: Record<string, unknown>) => ({
        id: "rec-1",
        kind: "fact",
        scope: "global",
        project_id: null,
        content: "release-hub runs on 124",
        negative: null,
        tags: ["infra"],
        status: "active",
        updated_at: "2026-09-28T02:40:00.000000Z",
        source_ref: "sessions/x.md",
        ...overrides,
      });
      const first = yield* repository.applyRemote([
        remote({}),
        remote({ id: "rec-2", kind: "lesson", content: "Branch before editing" }),
        remote({ id: "rec-3", scope: "project", project_id: null, content: "orphan" }),
      ]);
      assert.deepStrictEqual(first, { upserted: 2, removed: 0, skipped: 1 });
      // The layer shares one in-memory database across tests; look only at synced records.
      const synced = (memories: ReadonlyArray<AgentMemories.AgentMemory>) =>
        memories.filter((memory) => memory.id.startsWith("rec-"));
      const cached = synced(yield* repository.candidates(project));
      assert.deepStrictEqual(cached.map((memory) => [memory.id, memory.kind]).sort(), [
        ["rec-1", "memory"],
        ["rec-2", "lesson"],
      ]);
      assert.equal(cached.find((memory) => memory.id === "rec-1")?.sourceThreadId, "memory-api");

      const second = yield* repository.applyRemote([
        remote({ content: "release-hub runs on 124 in /opt/release-hub" }),
        remote({ id: "rec-2", kind: "lesson", status: "invalid" }),
      ]);
      assert.deepStrictEqual(second, { upserted: 1, removed: 1, skipped: 0 });
      const after = synced(yield* repository.candidates(project));
      assert.deepStrictEqual(
        after.map((memory) => memory.content),
        ["release-hub runs on 124 in /opt/release-hub"],
      );
    }),
  );
});
