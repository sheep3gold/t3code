import type { EnvironmentThreadSchedule } from "@t3tools/contracts";

export type ScheduleGroupKey = "upcoming" | "recurring" | "paused" | "completed";

export type ScheduleGroups = Record<ScheduleGroupKey, ReadonlyArray<EnvironmentThreadSchedule>>;

export type ScheduleDraft =
  | { readonly mode: "once"; readonly atLocal: string }
  | {
      readonly mode: "interval";
      readonly everyAmount: string;
      readonly everyUnit: "minutes" | "hours" | "days";
    }
  | {
      readonly mode: "cron";
      readonly cronExpression: string;
      readonly timezone: string;
      readonly skipDatesText: string;
    };

export type ResolvedScheduleDraft =
  | { readonly at: string; readonly everySeconds?: never; readonly cronExpression?: never }
  | { readonly at?: never; readonly everySeconds: number; readonly cronExpression?: never }
  | {
      readonly at?: never;
      readonly everySeconds?: never;
      readonly cronExpression: string;
      readonly timezone: string;
      readonly skipDates: ReadonlyArray<string>;
    };

const timestamp = (value: string | null): number => {
  if (value === null) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

export function groupSchedules(
  schedules: ReadonlyArray<EnvironmentThreadSchedule>,
): ScheduleGroups {
  const groups: Record<ScheduleGroupKey, EnvironmentThreadSchedule[]> = {
    upcoming: [],
    recurring: [],
    paused: [],
    completed: [],
  };

  for (const schedule of schedules) {
    if (schedule.status === "paused") {
      groups.paused.push(schedule);
    } else if (schedule.status === "completed") {
      groups.completed.push(schedule);
    } else if (schedule.scheduleKind === "interval" || schedule.scheduleKind === "cron") {
      groups.recurring.push(schedule);
    } else {
      groups.upcoming.push(schedule);
    }
  }

  groups.upcoming.sort((left, right) => timestamp(left.nextRunAt) - timestamp(right.nextRunAt));
  groups.recurring.sort((left, right) => timestamp(left.nextRunAt) - timestamp(right.nextRunAt));
  groups.paused.sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt));
  groups.completed.sort((left, right) => timestamp(right.lastRunAt) - timestamp(left.lastRunAt));

  return groups;
}

export function formatInterval(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return "Repeats";
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `Every ${days} ${days === 1 ? "day" : "days"}`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `Every ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const minutes = Math.round(seconds / 60);
  return `Every ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

export function resolveScheduleDraft(
  draft: ScheduleDraft,
  nowMs = Date.now(),
): { readonly value: ResolvedScheduleDraft | null; readonly error: string | null } {
  if (draft.mode === "once") {
    const atMs = Date.parse(draft.atLocal);
    if (!Number.isFinite(atMs)) {
      return { value: null, error: "Choose when this task should run." };
    }
    if (atMs < nowMs + 15_000) {
      return { value: null, error: "Choose a time at least 15 seconds from now." };
    }
    return { value: { at: new Date(atMs).toISOString() }, error: null };
  }

  if (draft.mode === "cron") {
    const cronExpression = draft.cronExpression.trim().replace(/\s+/g, " ");
    if (cronExpression.split(" ").length !== 5) {
      return { value: null, error: "Enter a five-field cron expression." };
    }
    const timezone = draft.timezone.trim();
    if (!timezone) return { value: null, error: "Enter an IANA timezone." };
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    } catch {
      return { value: null, error: "Enter a valid IANA timezone." };
    }
    const skipDates = [...new Set(draft.skipDatesText.split(/[\s,]+/).filter(Boolean))].sort();
    if (skipDates.length > 366 || skipDates.some((value) => !/^\d{4}-\d{2}-\d{2}$/.test(value))) {
      return { value: null, error: "Skip dates must be YYYY-MM-DD values separated by commas." };
    }
    return { value: { cronExpression, timezone, skipDates }, error: null };
  }

  const amount = Number(draft.everyAmount);
  if (!Number.isInteger(amount) || amount <= 0) {
    return { value: null, error: "Enter a whole-number interval." };
  }
  const multiplier = draft.everyUnit === "days" ? 86_400 : draft.everyUnit === "hours" ? 3_600 : 60;
  const everySeconds = amount * multiplier;
  if (everySeconds < 60) {
    return { value: null, error: "Recurring tasks must be at least one minute apart." };
  }
  return { value: { everySeconds }, error: null };
}
