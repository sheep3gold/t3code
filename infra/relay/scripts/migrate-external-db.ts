// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalConsoleInEffect:off - one-shot ops script, not a service.
// Applies migrations/postgres to a RELAY_DATABASE_URL Postgres when the relay
// runs without the PlanetScale resource that would otherwise apply them.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Redacted from "effect/Redacted";

const url = process.env.RELAY_DATABASE_URL?.trim();
if (!url) {
  console.error("Set RELAY_DATABASE_URL to the target Postgres connection string.");
  process.exit(1);
}
const migrationsDir = NodePath.resolve(import.meta.dirname, "../migrations/postgres");

const program = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  yield* sql`CREATE TABLE IF NOT EXISTS relay_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const names = NodeFS.readdirSync(migrationsDir)
    .filter((name) => /^\d/.test(name))
    .sort();
  for (const name of names) {
    const applied = yield* sql<{
      name: string;
    }>`SELECT name FROM relay_migrations WHERE name = ${name}`;
    if (applied.length > 0) continue;
    const raw = NodeFS.readFileSync(NodePath.join(migrationsDir, name, "migration.sql"), "utf8");
    const statements = raw
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const statement of statements) {
          yield* sql.unsafe(statement);
        }
        yield* sql`INSERT INTO relay_migrations (name) VALUES (${name})`;
      }),
    );
    console.log(`applied ${name}`);
  }
});

await Effect.runPromise(
  program.pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url) }))),
).catch((error) => {
  console.error(error);
  process.exit(1);
});
