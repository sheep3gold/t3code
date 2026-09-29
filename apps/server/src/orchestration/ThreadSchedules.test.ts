import { describe, expect, it } from "vite-plus/test";

import { nextThreadScheduleRun, resolveThreadSchedule } from "./ThreadSchedules.ts";

const onceMetadata = {
  cronExpression: null,
  timezone: null,
  skipDates: [],
} as const;

const intervalMetadata = onceMetadata;

describe("ThreadSchedules", () => {
  it("requires exactly one schedule shape and enforces minimums", () => {
    expect(resolveThreadSchedule({ nowMs: 0 })).toEqual({
      error: "Pass exactly one of at, delaySeconds, everySeconds, or cronExpression.",
    });
    expect(resolveThreadSchedule({ nowMs: 0, delaySeconds: 10 })).toEqual({
      error: "delaySeconds must be at least 15.",
    });
    expect(resolveThreadSchedule({ nowMs: 0, everySeconds: 30 })).toEqual({
      error: "everySeconds must be at least 60.",
    });
  });

  it("resolves one-shot and interval schedules", () => {
    expect(resolveThreadSchedule({ nowMs: 0, delaySeconds: 15 })).toEqual({
      scheduleKind: "once",
      intervalSeconds: null,
      ...onceMetadata,
      nextRunAt: "1970-01-01T00:00:15.000Z",
    });
    expect(resolveThreadSchedule({ nowMs: 0, everySeconds: 60 })).toEqual({
      scheduleKind: "interval",
      intervalSeconds: 60,
      ...intervalMetadata,
      nextRunAt: "1970-01-01T00:01:00.000Z",
    });
  });

  it("resolves five-field cron in its IANA timezone and skips local dates", () => {
    expect(
      resolveThreadSchedule({
        nowMs: Date.parse("2026-09-27T00:00:00.000Z"),
        cronExpression: "0 9 * * *",
        timezone: "Asia/Shanghai",
        skipDates: ["2026-09-27"],
      }),
    ).toEqual({
      scheduleKind: "cron",
      intervalSeconds: null,
      cronExpression: "0 9 * * *",
      timezone: "Asia/Shanghai",
      skipDates: ["2026-09-27"],
      nextRunAt: "2026-09-28T01:00:00.000Z",
    });
  });

  it("rejects six-field cron, invalid zones, and invalid skip dates", () => {
    expect(
      resolveThreadSchedule({ nowMs: 0, cronExpression: "0 0 9 * * *", timezone: "UTC" }),
    ).toEqual({ error: "cronExpression must contain exactly five fields." });
    expect(
      resolveThreadSchedule({ nowMs: 0, cronExpression: "0 9 * * *", timezone: "Moon/Base" }),
    ).toMatchObject({ error: expect.any(String) });
    expect(
      resolveThreadSchedule({
        nowMs: 0,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        skipDates: ["2026-02-30"],
      }),
    ).toMatchObject({ error: expect.stringContaining("YYYY-MM-DD") });
  });

  it("skips missed interval slots and advances cron without replaying a backlog", () => {
    expect(
      nextThreadScheduleRun(
        {
          scheduleKind: "interval",
          intervalSeconds: 60,
          ...intervalMetadata,
          nextRunAt: "1970-01-01T00:01:00.000Z",
        },
        190_000,
      ),
    ).toBe("1970-01-01T00:04:00.000Z");
    expect(
      nextThreadScheduleRun(
        {
          scheduleKind: "cron",
          intervalSeconds: null,
          cronExpression: "0 9 * * 1-5",
          timezone: "America/New_York",
          skipDates: [],
          nextRunAt: "2026-10-30T13:00:00.000Z",
        },
        Date.parse("2026-10-30T13:00:00.000Z"),
      ),
    ).toBe("2026-11-02T14:00:00.000Z");
    expect(
      nextThreadScheduleRun(
        {
          scheduleKind: "once",
          intervalSeconds: null,
          ...onceMetadata,
          nextRunAt: "1970-01-01T00:01:00.000Z",
        },
        60_000,
      ),
    ).toBeNull();
  });
});
