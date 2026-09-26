import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError } from "./Errors.ts";

export interface ThreadLedgerState {
  readonly goal: string | null;
  readonly phase: string | null;
  readonly next: string | null;
  readonly artifacts: Readonly<Record<string, string>>;
  readonly updatedAt: string;
}

export interface ThreadLedgerEvent {
  readonly id: number;
  readonly kind: string;
  readonly message: string;
  readonly createdAt: string;
}

export interface ThreadLedgerSnapshot {
  readonly state: ThreadLedgerState | null;
  readonly events: ReadonlyArray<ThreadLedgerEvent>;
}

interface StateRow {
  readonly goal: string | null;
  readonly phase: string | null;
  readonly next: string | null;
  readonly artifactsJson: string;
  readonly updatedAt: string;
}

interface EventRow {
  readonly id: number;
  readonly kind: string;
  readonly message: string;
  readonly createdAt: string;
}

export interface RecordThreadLedgerInput {
  readonly threadId: ThreadId;
  readonly state: Omit<ThreadLedgerState, "updatedAt">;
  readonly updatedAt: string;
  readonly event?: {
    readonly kind: string;
    readonly message: string;
  };
}

function parseArtifacts(value: string): Readonly<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

const sqlError = (operation: string) => (cause: unknown) =>
  new PersistenceSqlError({ operation, cause });

export class ThreadLedgerRepository extends Context.Service<
  ThreadLedgerRepository,
  {
    readonly read: (
      threadId: ThreadId,
      eventLimit?: number,
    ) => Effect.Effect<ThreadLedgerSnapshot, PersistenceSqlError>;
    readonly record: (
      input: RecordThreadLedgerInput,
    ) => Effect.Effect<ThreadLedgerSnapshot, PersistenceSqlError>;
  }
>()("t3/persistence/ThreadLedgerRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const read = (
    threadId: ThreadId,
    eventLimit = 20,
  ): Effect.Effect<ThreadLedgerSnapshot, PersistenceSqlError> =>
    Effect.gen(function* () {
      const states = yield* sql<StateRow>`
        SELECT
          goal,
          phase,
          next_step AS "next",
          artifacts_json AS "artifactsJson",
          updated_at AS "updatedAt"
        FROM thread_ledger_state
        WHERE thread_id = ${threadId}
        LIMIT 1
      `;
      const events = yield* sql<EventRow>`
        SELECT id, kind, message, created_at AS "createdAt"
        FROM thread_ledger_events
        WHERE thread_id = ${threadId}
        ORDER BY id DESC
        LIMIT ${Math.max(1, Math.min(100, eventLimit))}
      `;
      const state = states[0];
      return {
        state: state
          ? {
              goal: state.goal,
              phase: state.phase,
              next: state.next,
              artifacts: parseArtifacts(state.artifactsJson),
              updatedAt: state.updatedAt,
            }
          : null,
        events: events.toReversed(),
      };
    }).pipe(Effect.mapError(sqlError("readThreadLedger")));

  return ThreadLedgerRepository.of({
    read,
    record: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO thread_ledger_state (
                thread_id, goal, phase, next_step, artifacts_json, updated_at
              ) VALUES (
                ${input.threadId}, ${input.state.goal}, ${input.state.phase}, ${input.state.next},
                ${JSON.stringify(input.state.artifacts)}, ${input.updatedAt}
              )
              ON CONFLICT (thread_id)
              DO UPDATE SET
                goal = excluded.goal,
                phase = excluded.phase,
                next_step = excluded.next_step,
                artifacts_json = excluded.artifacts_json,
                updated_at = excluded.updated_at
            `;
            if (input.event) {
              yield* sql`
                INSERT INTO thread_ledger_events (thread_id, kind, message, created_at)
                VALUES (
                  ${input.threadId}, ${input.event.kind}, ${input.event.message}, ${input.updatedAt}
                )
              `;
            }
          }),
        )
        .pipe(
          Effect.andThen(read(input.threadId)),
          Effect.mapError(sqlError("recordThreadLedger")),
        ),
  });
});

export const layer = Layer.effect(ThreadLedgerRepository, make);
