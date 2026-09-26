import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "./Migrations.ts";
import * as ThreadSchedules from "./ThreadSchedules.ts";

const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });
const testLayer = Layer.mergeAll(sqlite, ThreadSchedules.layer.pipe(Layer.provide(sqlite)));
const layer = it.layer(testLayer);

layer("ThreadScheduleRepository", (it) => {
  it.effect("persists, pauses, resumes, runs, and completes schedules", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      const repository = yield* ThreadSchedules.ThreadScheduleRepository;
      const threadId = ThreadId.make("thread-scheduled");
      const created = yield* repository.create({
        id: "schedule-1",
        threadId,
        prompt: "Check CI",
        scheduleKind: "once",
        intervalSeconds: null,
        nextRunAt: "2026-09-26T12:00:00.000Z",
        createdAt: "2026-09-26T11:00:00.000Z",
      });
      assert.equal(created.status, "active");
      assert.equal((yield* repository.listDue("2026-09-26T11:59:59.000Z")).length, 0);
      assert.equal((yield* repository.listDue("2026-09-26T12:00:00.000Z")).length, 1);

      assert.equal(
        yield* repository.setPaused(
          created.id,
          threadId,
          true,
          "2026-09-26T11:30:00.000Z",
        ),
        true,
      );
      assert.equal((yield* repository.listDue("2026-09-26T12:00:00.000Z")).length, 0);
      assert.equal(
        yield* repository.setPaused(
          created.id,
          threadId,
          false,
          "2026-09-26T12:01:00.000Z",
        ),
        true,
      );
      const resumed = (yield* repository.list(threadId))[0]!;
      assert.equal(resumed.nextRunAt, "2026-09-26T12:01:00.000Z");
      assert.equal(
        yield* repository.recordRun(resumed, "2026-09-26T12:01:00.000Z", null),
        true,
      );
      const completed = (yield* repository.list(threadId))[0]!;
      assert.equal(completed.status, "completed");
      assert.equal(completed.lastRunAt, "2026-09-26T12:01:00.000Z");
      assert.equal(yield* repository.remove(completed.id, threadId), true);
      assert.equal((yield* repository.list(threadId)).length, 0);
    }),
  );
});
