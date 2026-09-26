import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError } from "./Errors.ts";

export interface ThreadPullRequestMonitorKey {
  readonly threadId: ThreadId;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

export interface ThreadPullRequestMonitorState {
  readonly fingerprint: string;
  readonly status: "active" | "terminal";
  readonly updatedAt: string;
}

const sqlError = (operation: string) => (cause: unknown) =>
  new PersistenceSqlError({ operation, cause });

export class ThreadPullRequestMonitorRepository extends Context.Service<
  ThreadPullRequestMonitorRepository,
  {
    readonly get: (
      key: ThreadPullRequestMonitorKey,
    ) => Effect.Effect<Option.Option<ThreadPullRequestMonitorState>, PersistenceSqlError>;
    readonly set: (
      key: ThreadPullRequestMonitorKey,
      state: ThreadPullRequestMonitorState,
    ) => Effect.Effect<void, PersistenceSqlError>;
  }
>()("t3/persistence/ThreadPullRequestMonitorRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return ThreadPullRequestMonitorRepository.of({
    get: (key) =>
      sql<ThreadPullRequestMonitorState>`
        SELECT fingerprint, status, updated_at AS "updatedAt"
        FROM thread_pr_monitor_state
        WHERE thread_id = ${key.threadId}
          AND host = ${key.host}
          AND repository = ${key.repository}
          AND number = ${key.number}
        LIMIT 1
      `.pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(sqlError("getThreadPullRequestMonitor")),
      ),
    set: (key, state) =>
      sql`
        INSERT INTO thread_pr_monitor_state (
          thread_id, host, repository, number, fingerprint, status, updated_at
        ) VALUES (
          ${key.threadId}, ${key.host}, ${key.repository}, ${key.number},
          ${state.fingerprint}, ${state.status}, ${state.updatedAt}
        )
        ON CONFLICT (thread_id, host, repository, number)
        DO UPDATE SET
          fingerprint = excluded.fingerprint,
          status = excluded.status,
          updated_at = excluded.updated_at
      `.pipe(
        Effect.asVoid,
        Effect.mapError(sqlError("setThreadPullRequestMonitor")),
      ),
  });
});

export const layer = Layer.effect(ThreadPullRequestMonitorRepository, make);
