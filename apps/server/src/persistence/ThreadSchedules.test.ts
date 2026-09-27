import { ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "./Migrations.ts";
import * as ThreadSchedules from "./ThreadSchedules.ts";

const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });
const testLayer = Layer.mergeAll(sqlite, ThreadSchedules.layer.pipe(Layer.provide(sqlite)));
const layer = it.layer(testLayer);

layer("ThreadScheduleRepository", (it) => {
  it.effect("persists, pauses, resumes, runs, and completes schedules", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 61 });
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
        yield* repository.setPaused(created.id, threadId, true, "2026-09-26T11:30:00.000Z"),
        true,
      );
      assert.equal((yield* repository.listDue("2026-09-26T12:00:00.000Z")).length, 0);
      assert.equal(
        yield* repository.setPaused(created.id, threadId, false, "2026-09-26T12:01:00.000Z"),
        true,
      );
      const resumed = (yield* repository.list(threadId))[0]!;
      assert.equal(resumed.nextRunAt, "2026-09-26T12:01:00.000Z");
      assert.equal(yield* repository.recordRun(resumed, "2026-09-26T12:01:00.000Z", null), true);
      const completed = (yield* repository.list(threadId))[0]!;
      assert.equal(completed.status, "completed");
      assert.equal(completed.lastRunAt, "2026-09-26T12:01:00.000Z");
      assert.equal(yield* repository.remove(completed.id, threadId), true);
      assert.equal((yield* repository.list(threadId)).length, 0);

      yield* repository.create({
        id: "schedule-cron",
        threadId,
        prompt: "Weekday check",
        scheduleKind: "cron",
        intervalSeconds: null,
        cronExpression: "0 9 * * 1-5",
        timezone: "Asia/Shanghai",
        skipDates: ["2026-10-01", "2026-10-02"],
        nextRunAt: "2026-09-28T01:00:00.000Z",
        createdAt: "2026-09-26T11:00:00.000Z",
      });
      const cron = (yield* repository.list(threadId))[0]!;
      assert.equal(cron.cronExpression, "0 9 * * 1-5");
      assert.equal(cron.timezone, "Asia/Shanghai");
      assert.deepStrictEqual(cron.skipDates, ["2026-10-01", "2026-10-02"]);
    }),
  );

  it.effect("lists and mutates schedules only within the requested project", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 61 });
      const repository = yield* ThreadSchedules.ThreadScheduleRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json,
          runtime_mode, interaction_mode, created_at, updated_at
        ) VALUES
          ('thread-a', 'project-a', 'Release checks', '{"provider":"codex","model":"gpt-5.4"}',
           'full-access', 'default', '2026-09-26T11:00:00.000Z', '2026-09-26T11:00:00.000Z'),
          ('thread-b', 'project-b', 'Other project', '{"provider":"codex","model":"gpt-5.4"}',
           'full-access', 'default', '2026-09-26T11:00:00.000Z', '2026-09-26T11:00:00.000Z')
      `;
      yield* repository.create({
        id: "schedule-a",
        threadId: ThreadId.make("thread-a"),
        prompt: "Check release",
        scheduleKind: "interval",
        intervalSeconds: 300,
        nextRunAt: "2026-09-26T12:00:00.000Z",
        createdAt: "2026-09-26T11:00:00.000Z",
      });
      yield* repository.create({
        id: "schedule-b",
        threadId: ThreadId.make("thread-b"),
        prompt: "Check elsewhere",
        scheduleKind: "once",
        intervalSeconds: null,
        nextRunAt: "2026-09-26T12:00:00.000Z",
        createdAt: "2026-09-26T11:00:00.000Z",
      });

      const projectSchedules = yield* repository.listProject(ProjectId.make("project-a"));
      assert.equal(projectSchedules.length, 1);
      assert.equal(projectSchedules[0]?.id, "schedule-a");
      assert.equal(projectSchedules[0]?.threadTitle, "Release checks");
      assert.equal(
        yield* repository.setPausedForProject(
          "schedule-b",
          ProjectId.make("project-a"),
          true,
          "2026-09-26T11:30:00.000Z",
        ),
        false,
      );
      assert.equal(
        yield* repository.setPausedForProject(
          "schedule-a",
          ProjectId.make("project-a"),
          true,
          "2026-09-26T11:30:00.000Z",
        ),
        true,
      );
      assert.equal(
        yield* repository.removeForProject("schedule-a", ProjectId.make("project-b")),
        false,
      );
      assert.equal(
        yield* repository.removeForProject("schedule-a", ProjectId.make("project-a")),
        true,
      );
    }),
  );
});
