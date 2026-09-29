import { ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "./Migrations.ts";
import * as Artifacts from "./Artifacts.ts";

const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });
const testLayer = Layer.mergeAll(sqlite, Artifacts.layer.pipe(Layer.provide(sqlite)));
const layer = it.layer(testLayer);

layer("ArtifactRepository", (it) => {
  it.effect("versions content, keeps metadata edits versionless, and reverts as a new version", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 58 });
      const repository = yield* Artifacts.ArtifactRepository;
      const projectId = ProjectId.make("project-1");
      const threadId = ThreadId.make("thread-1");
      const created = yield* repository.create({
        id: "artifact-1",
        slug: "release-notes-abcd1234",
        projectId,
        name: "Release notes",
        kind: "markdown",
        description: null,
        tags: ["release"],
        content: "v1",
        sourceThreadId: threadId,
        createdAt: "2026-09-26T12:00:00.000Z",
      });
      assert.equal(created.version, 1);

      const metadataOnly = yield* repository.update({
        projectId,
        slug: created.slug,
        name: "Release notes final",
        kind: "markdown",
        description: "Shipped notes",
        tags: ["release"],
        content: null,
        sourceThreadId: threadId,
        reason: "metadata",
        updatedAt: "2026-09-26T12:01:00.000Z",
      });
      assert.equal(Option.getOrThrow(metadataOnly).version, 1);

      const updated = yield* repository.update({
        projectId,
        slug: created.slug,
        name: "Release notes final",
        kind: "markdown",
        description: "Shipped notes",
        tags: ["release"],
        content: "v2",
        sourceThreadId: threadId,
        reason: "added validation",
        updatedAt: "2026-09-26T12:02:00.000Z",
      });
      assert.equal(Option.getOrThrow(updated).version, 2);

      const reverted = yield* repository.revert({
        projectId,
        slug: created.slug,
        targetVersion: 1,
        sourceThreadId: threadId,
        updatedAt: "2026-09-26T12:03:00.000Z",
      });
      assert.equal(Option.getOrThrow(reverted).version, 3);
      assert.equal(Option.getOrThrow(reverted).content, "v1");
      assert.deepStrictEqual(
        (yield* repository.versions(projectId, created.slug)).map((version) => version.version),
        [3, 2, 1],
      );
      assert.equal(yield* repository.remove(projectId, created.slug), true);
      assert.equal(Option.isNone(yield* repository.get(projectId, created.slug)), true);
    }),
  );
});
