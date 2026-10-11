import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Client-declared install anchor (ISO timestamp from the mobile app's per-install
// sandbox file), refreshed on every WebSocket connect. Nullable: old clients never
// report it. Compared against the previous value to detect app reinstalls.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;

  if (!columns.some((column) => column.name === "client_installed_at")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN client_installed_at TEXT
    `;
  }
});
