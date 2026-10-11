import { ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as McpAppModelContext from "./McpAppModelContext.ts";

const threadId = ThreadId.make("thread-context");
const projectId = ProjectId.make("project-context");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// One shared reference so the store and the test body see the same database.
const persistence = SqlitePersistenceMemory;
const layer = it.layer(
  Layer.merge(persistence, McpAppModelContext.layer.pipe(Layer.provide(persistence))),
);

/** An app's completed tool call in the thread's activity history. */
const insertAppActivity = (toolCallId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
      VALUES (
        ${`activity-${toolCallId}`},
        ${threadId},
        'turn-1',
        'tool',
        'tool.completed',
        'Ran app tool',
        ${encodeJson({ toolCallId })},
        '2026-01-01T00:00:00Z',
        1
      )
    `;
  });

const insertThread = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
    VALUES (${threadId}, ${projectId}, 'Context', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  `;
});

layer("McpAppModelContext", (it) => {
  it.effect("sends only apps still in the thread's history", () =>
    Effect.gen(function* () {
      yield* insertThread;
      yield* insertAppActivity("call-kept");
      const store = yield* McpAppModelContext.McpAppModelContext;
      const set = (toolCallId: string, text: string) =>
        store.set({
          threadId,
          toolCallId,
          server: "todos",
          tool: "list_todos",
          text,
        });
      yield* set("call-kept", "kept");
      yield* set("call-deleted", "from a call that is gone");

      const texts = () =>
        store.forThread(threadId).pipe(Effect.map((entries) => entries.map((entry) => entry.text)));
      assert.deepEqual(yield* texts(), ["kept"]);

      // Clearing removes the app's context.
      yield* set("call-kept", "");
      assert.deepEqual(yield* texts(), []);

      // A deleted thread stops informing the agent even if its rows remain.
      yield* set("call-kept", "kept again");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE projection_threads SET deleted_at = '2026-01-02T00:00:00Z'
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(yield* texts(), []);
    }),
  );
});
