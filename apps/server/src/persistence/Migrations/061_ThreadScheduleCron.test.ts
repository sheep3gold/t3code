import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("061_ThreadScheduleCron", (it) => {
  it.effect("preserves legacy schedules and accepts cron metadata", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* sql`
        INSERT INTO thread_schedules (
          id, thread_id, prompt, schedule_kind, interval_seconds,
          next_run_at, status, created_at, updated_at
        ) VALUES (
          'legacy', 'thread-1', 'Legacy interval', 'interval', 300,
          '2026-09-27T01:00:00.000Z', 'active',
          '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z'
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 61 });
      yield* sql`
        INSERT INTO thread_schedules (
          id, thread_id, prompt, schedule_kind, interval_seconds,
          cron_expression, timezone, skip_dates_json,
          next_run_at, status, created_at, updated_at
        ) VALUES (
          'cron', 'thread-1', 'Weekday check', 'cron', NULL,
          '0 9 * * 1-5', 'Asia/Shanghai', '["2026-10-01"]',
          '2026-09-28T01:00:00.000Z', 'active',
          '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z'
        )
      `;
      const rows = yield* sql<{
        readonly id: string;
        readonly cronExpression: string | null;
        readonly timezone: string | null;
        readonly skipDatesJson: string;
      }>`
        SELECT id, cron_expression AS "cronExpression", timezone,
          skip_dates_json AS "skipDatesJson"
        FROM thread_schedules ORDER BY id
      `;
      assert.deepStrictEqual(rows, [
        {
          id: "cron",
          cronExpression: "0 9 * * 1-5",
          timezone: "Asia/Shanghai",
          skipDatesJson: '["2026-10-01"]',
        },
        { id: "legacy", cronExpression: null, timezone: null, skipDatesJson: "[]" },
      ]);
    }),
  );
});
