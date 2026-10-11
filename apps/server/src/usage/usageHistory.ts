// @effect-diagnostics globalDate:off
/**
 * Day-window arithmetic and the per-day fold behind the provider usage
 * history payload.
 *
 * Pure, so the window math and fold are testable without the filesystem, the
 * network, or the clock.
 *
 * @module usage/usageHistory
 */
import type { UsageBucket, UsageDay } from "@t3tools/contracts";

import { totalTokens } from "./usageTranscripts.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value: string): value is UsageDay {
  return DAY_PATTERN.test(value);
}

/**
 * Formats an instant as the `YYYY-MM-DD` day the user experienced in
 * `timeZone`. `en-CA` yields ISO-ordered parts, which is why it is used here
 * rather than assembling the day from `Date` getters (those are host-local
 * only).
 */
export function dayInZone(timestampMs: number, timeZone: string): UsageDay {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    // An unknown zone should degrade to UTC rather than fail the whole scan.
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  return format.format(new Date(timestampMs)) as UsageDay;
}

/** `day + offsetDays`. Day arithmetic runs in UTC so a day never crosses a DST edge. */
export function shiftDay(day: UsageDay, offsetDays: number): UsageDay {
  const [year, month, date] = day.split("-").map(Number);
  if (year === undefined || month === undefined || date === undefined) {
    throw new Error(`shiftDay expects a YYYY-MM-DD day, got '${day}'`);
  }
  const shifted = new Date(Date.UTC(year, month - 1, date) + offsetDays * DAY_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` as UsageDay;
}

export interface HistoryDay {
  readonly day: UsageDay;
  readonly totalTokens: number;
  readonly costUsd: number;
}

/**
 * Folds the summary scan's `(day, provider, model)` buckets into one row per
 * calendar day in `[sinceDay, untilDay]`. Days with no records are zero-filled
 * so the chart shows honest gaps instead of compressing quiet days together.
 */
export function foldDailyUsage(
  buckets: readonly UsageBucket[],
  sinceDay: UsageDay,
  untilDay: UsageDay,
): HistoryDay[] {
  if (sinceDay > untilDay) return [];
  const sums = new Map<string, { totalTokens: number; costUsd: number }>();
  for (const bucket of buckets) {
    if (bucket.day < sinceDay || bucket.day > untilDay) continue;
    const sum = sums.get(bucket.day) ?? { totalTokens: 0, costUsd: 0 };
    sum.totalTokens += totalTokens(bucket.totals);
    sum.costUsd += bucket.costUsd;
    sums.set(bucket.day, sum);
  }
  const days: HistoryDay[] = [];
  for (let day = sinceDay; ; day = shiftDay(day, 1)) {
    const sum = sums.get(day);
    days.push({
      day,
      totalTokens: Math.max(0, Math.round(sum?.totalTokens ?? 0)),
      costUsd: sum?.costUsd ?? 0,
    });
    if (day === untilDay) return days;
  }
}
