import type { EnvironmentThreadSchedule } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatInterval, groupSchedules, resolveScheduleDraft } from "./ScheduleTimelinePage.logic";

const schedule = (
  overrides: Partial<EnvironmentThreadSchedule> & Pick<EnvironmentThreadSchedule, "id">,
): EnvironmentThreadSchedule => ({
  threadId: `thread-${overrides.id}` as EnvironmentThreadSchedule["threadId"],
  threadTitle: `Thread ${overrides.id}`,
  prompt: `Prompt ${overrides.id}`,
  scheduleKind: "once",
  intervalSeconds: null,
  cronExpression: null,
  timezone: null,
  skipDates: [],
  nextRunAt: "2026-09-27T10:00:00.000Z",
  status: "active",
  lastRunAt: null,
  createdAt: "2026-09-27T08:00:00.000Z",
  updatedAt: "2026-09-27T08:00:00.000Z",
  ...overrides,
});

describe("ScheduleTimelinePage logic", () => {
  it("groups schedules by operator intent and orders the active timelines", () => {
    const groups = groupSchedules([
      schedule({ id: "later", nextRunAt: "2026-09-27T12:00:00.000Z" }),
      schedule({ id: "paused", status: "paused" }),
      schedule({ id: "done", status: "completed", lastRunAt: "2026-09-27T09:00:00.000Z" }),
      schedule({
        id: "recurring",
        scheduleKind: "interval",
        intervalSeconds: 3600,
        nextRunAt: "2026-09-27T11:00:00.000Z",
      }),
      schedule({
        id: "cron",
        scheduleKind: "cron",
        cronExpression: "0 9 * * 1-5",
        timezone: "Asia/Shanghai",
        skipDates: ["2026-10-01"],
        nextRunAt: "2026-09-28T01:00:00.000Z",
      }),
      schedule({ id: "sooner", nextRunAt: "2026-09-27T09:00:00.000Z" }),
    ]);

    expect(groups.upcoming.map(({ id }) => id)).toEqual(["sooner", "later"]);
    expect(groups.recurring.map(({ id }) => id)).toEqual(["recurring", "cron"]);
    expect(groups.paused.map(({ id }) => id)).toEqual(["paused"]);
    expect(groups.completed.map(({ id }) => id)).toEqual(["done"]);
  });

  it("formats useful interval units", () => {
    expect(formatInterval(60)).toBe("Every 1 minute");
    expect(formatInterval(7200)).toBe("Every 2 hours");
    expect(formatInterval(172800)).toBe("Every 2 days");
  });

  it("resolves one-time and recurring form values", () => {
    const atLocal = "2026-09-27T10:00";
    const atMs = Date.parse(atLocal);
    expect(resolveScheduleDraft({ mode: "once", atLocal }, atMs - 60 * 60_000)).toEqual({
      value: { at: new Date(atMs).toISOString() },
      error: null,
    });
    expect(
      resolveScheduleDraft({ mode: "interval", everyAmount: "6", everyUnit: "hours" }),
    ).toEqual({ value: { everySeconds: 21600 }, error: null });
    expect(
      resolveScheduleDraft({
        mode: "cron",
        cronExpression: "0  9 * * 1-5",
        timezone: "Asia/Shanghai",
        skipDatesText: "2026-10-02, 2026-10-01, 2026-10-02",
      }),
    ).toEqual({
      value: {
        cronExpression: "0 9 * * 1-5",
        timezone: "Asia/Shanghai",
        skipDates: ["2026-10-01", "2026-10-02"],
      },
      error: null,
    });
  });

  it("rejects stale times and invalid intervals", () => {
    expect(
      resolveScheduleDraft(
        { mode: "once", atLocal: "2026-09-27T09:00" },
        Date.parse("2026-09-27T09:00:00Z"),
      ),
    ).toMatchObject({ value: null });
    expect(
      resolveScheduleDraft({ mode: "interval", everyAmount: "0", everyUnit: "minutes" }),
    ).toMatchObject({ value: null });
  });
});
