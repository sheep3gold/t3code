/**
 * Kiro CLI credentials for the usage probe.
 *
 * kiro-cli keeps its OIDC token in a SQLite database under its data
 * directory (`auth_kv` / `kirocli:odic:token`). That row is short-lived —
 * the access token lives about a quarter of an hour — so a probe that reads
 * a stale row fails even while the account is signed in. Renewing the token
 * is kiro-cli's own job: `kiro-cli whoami` refreshes it and writes it back.
 * This module shells out to the CLI rather than replaying the OIDC refresh
 * handshake with the client secret it would otherwise have to read.
 *
 * @module fork/usage/kiroCredentials
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

/** kiro-cli's data directory, relative to the user's home. */
const KIRO_DATA_DIR = ".local/share/kiro-cli";
const KIRO_STATE_DB = "data.sqlite3";
const KIRO_TOKEN_KEY = "kirocli:odic:token";

/**
 * A token with less than this much life left is renewed before it is used:
 * the CodeWhisperer call it authorizes would otherwise race the expiry.
 */
const EXPIRY_MARGIN_MS = 60_000;

/** kiro-cli is a local command, not a service; a slow start is a bad install. */
const REFRESH_TIMEOUT_MS = 20_000;

/** The CodeWhisperer runtime lives in one region; the token names the one in use. */
const DEFAULT_REGION = "us-east-1";

export interface KiroOauthToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
  readonly region: string;
}

const tokenDatabasePath = (homeDirectory: string): string =>
  NodePath.join(homeDirectory, KIRO_DATA_DIR, KIRO_STATE_DB);

/**
 * Read the stored token. The CLI owns this database, so the probe opens it
 * read-only: a live session must not be disturbed by a health check. The
 * timeout absorbs the brief exclusive lock a rollback-journal writer holds.
 */
const readStoredToken = (homeDirectory: string): KiroOauthToken | null => {
  let database: NodeSqlite.DatabaseSync | undefined;
  try {
    database = new NodeSqlite.DatabaseSync(tokenDatabasePath(homeDirectory), {
      readOnly: true,
      timeout: 2_000,
    });
    const row = database
      .prepare("select value from auth_kv where key = ?")
      .get(KIRO_TOKEN_KEY) as { value?: unknown } | undefined;
    if (row === undefined || typeof row.value !== "string") return null;
    const stored = JSON.parse(row.value) as {
      readonly access_token?: unknown;
      readonly expires_at?: unknown;
      readonly region?: unknown;
    };
    if (typeof stored.access_token !== "string" || stored.access_token.length === 0) return null;
    const expiresAtMs =
      typeof stored.expires_at === "string" ? Date.parse(stored.expires_at) : Number.NaN;
    return {
      accessToken: stored.access_token,
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : 0,
      region:
        typeof stored.region === "string" && stored.region.length > 0
          ? stored.region
          : DEFAULT_REGION,
    };
  } catch {
    return null;
  } finally {
    database?.close();
  }
};

/**
 * Ask kiro-cli to renew its token. `whoami` is the cheapest command that
 * forces the refresh; whether it actually renewed is decided by re-reading
 * the database, so a failure here needs no special handling.
 */
const refreshStoredToken = (homeDirectory: string, commandPath: string): Effect.Effect<void> =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        NodeChildProcess.execFile(
          commandPath,
          ["whoami"],
          { timeout: REFRESH_TIMEOUT_MS, env: { ...process.env, HOME: homeDirectory } },
          () => resolve(),
        );
      }),
  );

/**
 * The signed-in account's access token, renewed when it is about to expire.
 * `null` means kiro-cli holds no token for this user — not signed in.
 */
export const ensureKiroOauthToken = (
  homeDirectory: string,
  commandPath: string,
): Effect.Effect<KiroOauthToken | null> =>
  Effect.gen(function* () {
    const stored = readStoredToken(homeDirectory);
    if (stored === null) return null;
    const nowMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
    if (stored.expiresAtMs - nowMs > EXPIRY_MARGIN_MS) return stored;
    yield* refreshStoredToken(homeDirectory, commandPath);
    return readStoredToken(homeDirectory);
  });
