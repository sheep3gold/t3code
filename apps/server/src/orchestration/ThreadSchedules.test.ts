import { describe, expect, it } from "vite-plus/test";

import { nextThreadScheduleRun, resolveThreadSchedule } from "./ThreadSchedules.ts";

describe("ThreadSchedules", () => {
  it("requires exactly one schedule shape and enforces minimums", () => {
    expect(resolveThreadSchedule({ nowMs: 0 })).toEqual({
      error: "Pass exactly one of at, delaySeconds, or everySeconds.",
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
      nextRunAt: "1970-01-01T00:00:15.000Z",
    });
    expect(resolveThreadSchedule({ nowMs: 0, everySeconds: 60 })).toEqual({
      scheduleKind: "interval",
      intervalSeconds: 60,
      nextRunAt: "1970-01-01T00:01:00.000Z",
    });
  });

  it("skips missed interval slots instead of replaying a backlog", () => {
    expect(
      nextThreadScheduleRun(
        {
          scheduleKind: "interval",
          intervalSeconds: 60,
          nextRunAt: "1970-01-01T00:01:00.000Z",
        },
        190_000,
      ),
    ).toBe("1970-01-01T00:04:00.000Z");
    expect(
      nextThreadScheduleRun(
        { scheduleKind: "once", intervalSeconds: null, nextRunAt: "1970-01-01T00:01:00.000Z" },
        60_000,
      ),
    ).toBeNull();
  });
});
