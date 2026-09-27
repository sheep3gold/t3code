import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type OrchestrationThreadShell,
  type ProjectId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ThreadSchedules from "../persistence/ThreadSchedules.ts";
import { resolveThreadSchedule } from "../orchestration/ThreadSchedules.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const MAX_PROMPT_CHARS = 20_000;

const publicSchedule = (schedule: ThreadSchedules.ThreadSchedule, threadTitle: string) => ({
  id: schedule.id,
  threadId: schedule.threadId,
  threadTitle,
  prompt: schedule.prompt,
  scheduleKind: schedule.scheduleKind,
  intervalSeconds: schedule.intervalSeconds,
  cronExpression: schedule.cronExpression,
  timezone: schedule.timezone,
  skipDates: schedule.skipDates,
  nextRunAt: schedule.nextRunAt,
  status: schedule.status,
  lastRunAt: schedule.lastRunAt,
  createdAt: schedule.createdAt,
  updatedAt: schedule.updatedAt,
});

export function canScheduleThread(
  thread: Pick<OrchestrationThreadShell, "projectId" | "archivedAt">,
  projectId: ProjectId,
): boolean {
  return thread.projectId === projectId && thread.archivedAt === null;
}

export const schedulesHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "schedules",
  Effect.fnUntraced(function* (handlers) {
    const repository = yield* ThreadSchedules.ThreadScheduleRepository;
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const crypto = yield* Crypto.Crypto;
    const readScope = (endpoint: string) =>
      annotateEnvironmentRequest(endpoint).pipe(
        Effect.andThen(requireEnvironmentScope(AuthOrchestrationReadScope)),
      );
    const operateScope = (endpoint: string) =>
      annotateEnvironmentRequest(endpoint).pipe(
        Effect.andThen(requireEnvironmentScope(AuthOrchestrationOperateScope)),
      );
    const internal = (cause: unknown) => failEnvironmentInternal("internal_error", cause);

    return handlers
      .handle(
        "list",
        Effect.fn("environment.schedules.list")(function* (args) {
          yield* readScope(args.endpoint.name);
          const schedules = yield* repository
            .listProject(args.payload.projectId)
            .pipe(Effect.catch(internal));
          return {
            schedules: schedules.map((schedule) => publicSchedule(schedule, schedule.threadTitle)),
          };
        }),
      )
      .handle(
        "create",
        Effect.fn("environment.schedules.create")(function* (args) {
          yield* operateScope(args.endpoint.name);
          if (Array.from(args.payload.prompt).length > MAX_PROMPT_CHARS) {
            return yield* failEnvironmentInvalidRequest("invalid_schedule");
          }
          const thread = yield* snapshots
            .getThreadShellById(args.payload.threadId)
            .pipe(Effect.catch(internal));
          if (Option.isNone(thread) || !canScheduleThread(thread.value, args.payload.projectId)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          const nowMs = yield* Clock.currentTimeMillis;
          const resolved = resolveThreadSchedule({
            nowMs,
            ...(args.payload.at === undefined ? {} : { at: args.payload.at }),
            ...(args.payload.delaySeconds === undefined
              ? {}
              : { delaySeconds: args.payload.delaySeconds }),
            ...(args.payload.everySeconds === undefined
              ? {}
              : { everySeconds: args.payload.everySeconds }),
            ...(args.payload.cronExpression === undefined
              ? {}
              : { cronExpression: args.payload.cronExpression }),
            ...(args.payload.timezone === undefined ? {} : { timezone: args.payload.timezone }),
            ...(args.payload.skipDates === undefined ? {} : { skipDates: args.payload.skipDates }),
          });
          if ("error" in resolved) {
            return yield* failEnvironmentInvalidRequest("invalid_schedule");
          }
          const createdAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
          const schedule = yield* repository
            .create({
              id: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
              threadId: args.payload.threadId,
              prompt: args.payload.prompt,
              ...resolved,
              createdAt,
            })
            .pipe(Effect.catch(internal));
          return publicSchedule(schedule, thread.value.title);
        }),
      )
      .handle(
        "pause",
        Effect.fn("environment.schedules.pause")(function* (args) {
          yield* operateScope(args.endpoint.name);
          const changed = yield* repository
            .setPausedForProject(
              args.params.scheduleId,
              args.payload.projectId,
              true,
              DateTime.formatIso(yield* DateTime.now),
            )
            .pipe(Effect.catch(internal));
          return { changed };
        }),
      )
      .handle(
        "resume",
        Effect.fn("environment.schedules.resume")(function* (args) {
          yield* operateScope(args.endpoint.name);
          const changed = yield* repository
            .setPausedForProject(
              args.params.scheduleId,
              args.payload.projectId,
              false,
              DateTime.formatIso(yield* DateTime.now),
            )
            .pipe(Effect.catch(internal));
          return { changed };
        }),
      )
      .handle(
        "remove",
        Effect.fn("environment.schedules.remove")(function* (args) {
          yield* operateScope(args.endpoint.name);
          const changed = yield* repository
            .removeForProject(args.params.scheduleId, args.payload.projectId)
            .pipe(Effect.catch(internal));
          return { changed };
        }),
      );
  }),
);
