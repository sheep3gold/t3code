import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError } from "./Errors.ts";

export type ArtifactKind = "text" | "markdown" | "json" | "html" | "svg";

export interface ArtifactSummary {
  readonly id: string;
  readonly slug: string;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly kind: ArtifactKind;
  readonly description: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly currentVersion: number;
  readonly sourceThreadId: ThreadId;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArtifactDetail extends ArtifactSummary {
  readonly version: number;
  readonly content: string;
  readonly versionReason: string;
  readonly versionCreatedAt: string;
}

interface ArtifactRow {
  readonly id: string;
  readonly slug: string;
  readonly projectId: string;
  readonly name: string;
  readonly kind: ArtifactKind;
  readonly description: string | null;
  readonly tagsJson: string;
  readonly currentVersion: number;
  readonly sourceThreadId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ArtifactDetailRow extends ArtifactRow {
  readonly version: number;
  readonly content: string;
  readonly versionReason: string;
  readonly versionCreatedAt: string;
}

export interface ArtifactVersionEntry {
  readonly version: number;
  readonly reason: string;
  readonly sourceThreadId: ThreadId;
  readonly createdAt: string;
}

function tagsOf(value: string): ReadonlyArray<string> {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

function summaryOf(row: ArtifactRow): ArtifactSummary {
  return {
    ...row,
    projectId: ProjectId.make(row.projectId),
    tags: tagsOf(row.tagsJson),
    sourceThreadId: ThreadId.make(row.sourceThreadId),
  };
}

function detailOf(row: ArtifactDetailRow): ArtifactDetail {
  return { ...summaryOf(row), version: row.version, content: row.content, versionReason: row.versionReason, versionCreatedAt: row.versionCreatedAt };
}

const sqlError = (operation: string) => (cause: unknown) =>
  new PersistenceSqlError({ operation, cause });

export class ArtifactRepository extends Context.Service<
  ArtifactRepository,
  {
    readonly create: (input: {
      readonly id: string;
      readonly slug: string;
      readonly projectId: ProjectId;
      readonly name: string;
      readonly kind: ArtifactKind;
      readonly description: string | null;
      readonly tags: ReadonlyArray<string>;
      readonly content: string;
      readonly sourceThreadId: ThreadId;
      readonly createdAt: string;
    }) => Effect.Effect<ArtifactDetail, PersistenceSqlError>;
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<ArtifactSummary>, PersistenceSqlError>;
    readonly get: (
      projectId: ProjectId,
      slug: string,
      version?: number,
    ) => Effect.Effect<Option.Option<ArtifactDetail>, PersistenceSqlError>;
    readonly update: (input: {
      readonly projectId: ProjectId;
      readonly slug: string;
      readonly name: string;
      readonly kind: ArtifactKind;
      readonly description: string | null;
      readonly tags: ReadonlyArray<string>;
      readonly content: string | null;
      readonly sourceThreadId: ThreadId;
      readonly reason: string;
      readonly updatedAt: string;
    }) => Effect.Effect<Option.Option<ArtifactDetail>, PersistenceSqlError>;
    readonly revert: (input: {
      readonly projectId: ProjectId;
      readonly slug: string;
      readonly targetVersion: number;
      readonly sourceThreadId: ThreadId;
      readonly updatedAt: string;
    }) => Effect.Effect<Option.Option<ArtifactDetail>, PersistenceSqlError>;
    readonly versions: (
      projectId: ProjectId,
      slug: string,
    ) => Effect.Effect<ReadonlyArray<ArtifactVersionEntry>, PersistenceSqlError>;
    readonly remove: (
      projectId: ProjectId,
      slug: string,
    ) => Effect.Effect<boolean, PersistenceSqlError>;
  }
>()("t3/persistence/ArtifactRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const get = (
    projectId: ProjectId,
    slug: string,
    version?: number,
  ): Effect.Effect<Option.Option<ArtifactDetail>, PersistenceSqlError> =>
    (version === undefined
      ? sql<ArtifactDetailRow>`
          SELECT
            a.id, a.slug, a.project_id AS "projectId", a.name, a.kind, a.description,
            a.tags_json AS "tagsJson", a.current_version AS "currentVersion",
            a.source_thread_id AS "sourceThreadId", a.created_at AS "createdAt",
            a.updated_at AS "updatedAt", v.version, v.content,
            v.reason AS "versionReason", v.created_at AS "versionCreatedAt"
          FROM artifacts a
          JOIN artifact_versions v
            ON v.artifact_id = a.id AND v.version = a.current_version
          WHERE a.project_id = ${projectId} AND a.slug = ${slug}
          LIMIT 1
        `
      : sql<ArtifactDetailRow>`
          SELECT
            a.id, a.slug, a.project_id AS "projectId", a.name, a.kind, a.description,
            a.tags_json AS "tagsJson", a.current_version AS "currentVersion",
            a.source_thread_id AS "sourceThreadId", a.created_at AS "createdAt",
            a.updated_at AS "updatedAt", v.version, v.content,
            v.reason AS "versionReason", v.created_at AS "versionCreatedAt"
          FROM artifacts a
          JOIN artifact_versions v ON v.artifact_id = a.id
          WHERE a.project_id = ${projectId} AND a.slug = ${slug} AND v.version = ${version}
          LIMIT 1
        `
    ).pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(detailOf))),
      Effect.mapError(sqlError("getArtifact")),
    );

  return ArtifactRepository.of({
    create: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO artifacts (
                id, slug, project_id, name, kind, description, tags_json,
                current_version, source_thread_id, created_at, updated_at
              ) VALUES (
                ${input.id}, ${input.slug}, ${input.projectId}, ${input.name}, ${input.kind},
                ${input.description}, ${JSON.stringify(input.tags)}, 1, ${input.sourceThreadId},
                ${input.createdAt}, ${input.createdAt}
              )
            `;
            yield* sql`
              INSERT INTO artifact_versions (
                artifact_id, version, content, source_thread_id, reason, created_at
              ) VALUES (${input.id}, 1, ${input.content}, ${input.sourceThreadId}, 'created', ${input.createdAt})
            `;
          }),
        )
        .pipe(
          Effect.andThen(get(input.projectId, input.slug)),
          Effect.map(Option.getOrThrow),
          Effect.mapError(sqlError("createArtifact")),
        ),

    list: (projectId) =>
      sql<ArtifactRow>`
        SELECT
          a.id, a.slug, a.project_id AS "projectId", a.name, a.kind, a.description,
          a.tags_json AS "tagsJson", a.current_version AS "currentVersion",
          a.source_thread_id AS "sourceThreadId", a.created_at AS "createdAt",
          a.updated_at AS "updatedAt"
        FROM artifacts a
        WHERE a.project_id = ${projectId}
        ORDER BY a.updated_at DESC
        LIMIT 200
      `.pipe(
        Effect.map((rows) => rows.map(summaryOf)),
        Effect.mapError(sqlError("listArtifacts")),
      ),

    get,

    update: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly id: string; readonly currentVersion: number }>`
              SELECT id, current_version AS "currentVersion"
              FROM artifacts
              WHERE project_id = ${input.projectId} AND slug = ${input.slug}
              LIMIT 1
            `;
            const current = rows[0];
            if (!current) return false;
            const nextVersion = current.currentVersion + (input.content === null ? 0 : 1);
            if (input.content !== null) {
              yield* sql`
                INSERT INTO artifact_versions (
                  artifact_id, version, content, source_thread_id, reason, created_at
                ) VALUES (
                  ${current.id}, ${nextVersion}, ${input.content}, ${input.sourceThreadId},
                  ${input.reason}, ${input.updatedAt}
                )
              `;
            }
            yield* sql`
              UPDATE artifacts
              SET name = ${input.name}, kind = ${input.kind}, description = ${input.description},
                  tags_json = ${JSON.stringify(input.tags)}, current_version = ${nextVersion},
                  source_thread_id = ${input.sourceThreadId}, updated_at = ${input.updatedAt}
              WHERE id = ${current.id}
            `;
            return true;
          }),
        )
        .pipe(
          Effect.flatMap((found) => found ? get(input.projectId, input.slug) : Effect.succeed(Option.none())),
          Effect.mapError(sqlError("updateArtifact")),
        ),

    revert: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const target = yield* get(input.projectId, input.slug, input.targetVersion);
            if (Option.isNone(target)) return false;
            const nextVersion = target.value.currentVersion + 1;
            yield* sql`
              INSERT INTO artifact_versions (
                artifact_id, version, content, source_thread_id, reason, created_at
              ) VALUES (
                ${target.value.id}, ${nextVersion}, ${target.value.content}, ${input.sourceThreadId},
                ${`reverted from v${input.targetVersion}`}, ${input.updatedAt}
              )
            `;
            yield* sql`
              UPDATE artifacts
              SET current_version = ${nextVersion}, source_thread_id = ${input.sourceThreadId},
                  updated_at = ${input.updatedAt}
              WHERE id = ${target.value.id}
            `;
            return true;
          }),
        )
        .pipe(
          Effect.flatMap((found) => found ? get(input.projectId, input.slug) : Effect.succeed(Option.none())),
          Effect.mapError(sqlError("revertArtifact")),
        ),

    versions: (projectId, slug) =>
      sql<{
        readonly version: number;
        readonly reason: string;
        readonly sourceThreadId: string;
        readonly createdAt: string;
      }>`
        SELECT v.version, v.reason, v.source_thread_id AS "sourceThreadId",
               v.created_at AS "createdAt"
        FROM artifact_versions v
        JOIN artifacts a ON a.id = v.artifact_id
        WHERE a.project_id = ${projectId} AND a.slug = ${slug}
        ORDER BY v.version DESC
        LIMIT 200
      `.pipe(
        Effect.map((rows) => rows.map((row) => ({ ...row, sourceThreadId: ThreadId.make(row.sourceThreadId) }))),
        Effect.mapError(sqlError("listArtifactVersions")),
      ),

    remove: (projectId, slug) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly id: string }>`
              SELECT id FROM artifacts WHERE project_id = ${projectId} AND slug = ${slug} LIMIT 1
            `;
            const id = rows[0]?.id;
            if (!id) return false;
            yield* sql`DELETE FROM artifact_versions WHERE artifact_id = ${id}`;
            yield* sql`DELETE FROM artifacts WHERE id = ${id}`;
            return true;
          }),
        )
        .pipe(Effect.mapError(sqlError("removeArtifact"))),
  });
});

export const layer = Layer.effect(ArtifactRepository, make);
