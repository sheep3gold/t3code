import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "last_read_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN last_read_at TEXT
    `;
    // Start shared read state from a clean slate: every completion that
    // exists at upgrade time counts as seen. Read state used to live on each
    // device, so there is no cross-device truth to carry over, and stale
    // per-device stamps are exactly what made other devices show old
    // completions as unread.
    yield* sql`
      UPDATE projection_threads
      SET last_read_at = (
        SELECT turns.completed_at
        FROM projection_turns AS turns
        WHERE turns.thread_id = projection_threads.thread_id
          AND turns.turn_id = projection_threads.latest_turn_id
      )
      WHERE latest_turn_id IS NOT NULL
    `;
  }
});
