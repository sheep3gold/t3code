import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as ArtifactPersistence from "../persistence/Artifacts.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

const MAX_NAME_CHARS = 100;
const MAX_DESCRIPTION_CHARS = 1_000;
const MAX_CONTENT_CHARS = 200_000;
const MAX_TAGS = 16;
const MAX_TAG_CHARS = 80;

const ArtifactKind = Schema.Literals(["text", "markdown", "json", "html", "svg"]);
const ArtifactSummary = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
  kind: ArtifactKind,
  description: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  currentVersion: Schema.Number,
  sourceThreadId: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const ArtifactDetail = Schema.Struct({
  ...ArtifactSummary.fields,
  version: Schema.Number,
  content: Schema.String,
  versionReason: Schema.String,
  versionCreatedAt: Schema.String,
});

const SaveArtifactInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  content: Schema.String,
  kind: ArtifactKind,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  tags: Schema.optional(Schema.Array(Schema.String)),
});
const ArtifactSlugInput = Schema.Struct({ slug: TrimmedNonEmptyString });
const GetArtifactInput = Schema.Struct({
  slug: TrimmedNonEmptyString,
  version: Schema.optional(Schema.Int),
});
const UpdateArtifactInput = Schema.Struct({
  slug: TrimmedNonEmptyString,
  content: Schema.optional(Schema.String),
  name: Schema.optional(TrimmedNonEmptyString),
  kind: Schema.optional(ArtifactKind),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  tags: Schema.optional(Schema.Array(Schema.String)),
  reason: Schema.optional(TrimmedNonEmptyString),
});
const RevertArtifactInput = Schema.Struct({
  slug: TrimmedNonEmptyString,
  targetVersion: Schema.Int,
});

export class ArtifactInputInvalidError extends Schema.TaggedError<ArtifactInputInvalidError>()(
  "ArtifactInputInvalidError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
export class ArtifactNotFoundError extends Schema.TaggedError<ArtifactNotFoundError>()(
  "ArtifactNotFoundError",
  { slug: Schema.String },
) {
  override get message(): string {
    return `Artifact '${this.slug}' was not found in this project.`;
  }
}
export class ArtifactThreadNotFoundError extends Schema.TaggedError<ArtifactThreadNotFoundError>()(
  "ArtifactThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}
export class ArtifactOperationError extends Schema.TaggedError<ArtifactOperationError>()(
  "ArtifactOperationError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Artifact operation '${this.operation}' failed.`;
  }
}
const ArtifactToolError = Schema.Union([
  ArtifactInputInvalidError,
  ArtifactNotFoundError,
  ArtifactThreadNotFoundError,
  ArtifactOperationError,
]);

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ArtifactPersistence.ArtifactRepository,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  Crypto.Crypto,
  Clock.Clock,
];

const SaveArtifactTool = Tool.make("artifact_save", {
  description:
    "Save text, markdown, JSON, HTML, or SVG as a versioned artifact in this project. The content is stored as data and is not executed. Returns a stable slug for later threads.",
  parameters: SaveArtifactInput,
  success: ArtifactDetail,
  failure: ArtifactToolError,
  dependencies,
})
  .annotate(Tool.Title, "Save artifact")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ListArtifactsTool = Tool.make("artifact_list", {
  description: "List versioned artifacts in this project without loading their content.",
  success: Schema.Struct({ artifacts: Schema.Array(ArtifactSummary) }),
  failure: ArtifactToolError,
  dependencies,
})
  .annotate(Tool.Title, "List artifacts")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const GetArtifactTool = Tool.make("artifact_get", {
  description: "Read the current or a specific historical version of an artifact by slug.",
  parameters: GetArtifactInput,
  success: ArtifactDetail,
  failure: ArtifactToolError,
  dependencies,
})
  .annotate(Tool.Title, "Get artifact")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UpdateArtifactTool = Tool.make("artifact_update", {
  description:
    "Update an artifact. Supplying content creates a new immutable version; metadata-only changes retain the current version.",
  parameters: UpdateArtifactInput,
  success: ArtifactDetail,
  failure: ArtifactToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update artifact")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ArtifactVersionsTool = Tool.make("artifact_versions", {
  description: "List an artifact's immutable version history without loading version content.",
  parameters: ArtifactSlugInput,
  success: Schema.Struct({
    versions: Schema.Array(
      Schema.Struct({
        version: Schema.Number,
        reason: Schema.String,
        sourceThreadId: Schema.String,
        createdAt: Schema.String,
      }),
    ),
  }),
  failure: ArtifactToolError,
  dependencies,
})
  .annotate(Tool.Title, "List artifact versions")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RevertArtifactTool = Tool.make("artifact_revert", {
  description:
    "Restore a historical version as a new current version. Existing history remains unchanged.",
  parameters: RevertArtifactInput,
  success: ArtifactDetail,
  failure: ArtifactToolError,
  dependencies,
})
  .annotate(Tool.Title, "Revert artifact")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const DeleteArtifactTool = Tool.make("artifact_delete", {
  description: "Permanently delete one artifact and all of its versions from this project.",
  parameters: ArtifactSlugInput,
  success: Schema.Struct({ removed: Schema.Boolean }),
  failure: ArtifactToolError,
  dependencies,
})
  .annotate(Tool.Title, "Delete artifact")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ArtifactToolkit = Toolkit.make(
  SaveArtifactTool,
  ListArtifactsTool,
  GetArtifactTool,
  UpdateArtifactTool,
  ArtifactVersionsTool,
  RevertArtifactTool,
  DeleteArtifactTool,
);

function clip(value: string, limit: number): string {
  return Array.from(value.trim()).slice(0, limit).join("");
}
function normalizedTags(tags: ReadonlyArray<string> | undefined): ReadonlyArray<string> | null {
  if ((tags?.length ?? 0) > MAX_TAGS) return null;
  return [...new Set((tags ?? []).map((tag) => clip(tag, MAX_TAG_CHARS)).filter(Boolean))];
}
export function artifactSlug(name: string, suffix: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "") || "artifact";
  return `${base}-${suffix.slice(0, 8).toLowerCase()}`;
}
function validContent(content: string): boolean {
  return Array.from(content).length <= MAX_CONTENT_CHARS;
}

const make = Effect.gen(function* () {
  const repository = yield* ArtifactPersistence.ArtifactRepository;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const context = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const thread = yield* snapshots
      .getThreadShellById(scope.threadId)
      .pipe(
        Effect.mapError((cause) => new ArtifactOperationError({ operation: "read-thread", cause })),
        Effect.map(Option.getOrUndefined),
      );
    if (!thread || thread.archivedAt !== null || thread.deletedAt !== null) {
      return yield* new ArtifactThreadNotFoundError({ threadId: scope.threadId });
    }
    return { scope, projectId: thread.projectId };
  });

  const operationError = (operation: string) =>
    Effect.mapError((cause: unknown) => new ArtifactOperationError({ operation, cause }));
  const requireArtifact = <A>(slug: string, value: Option.Option<A>) =>
    Option.match(value, {
      onNone: () => Effect.fail(new ArtifactNotFoundError({ slug })),
      onSome: Effect.succeed,
    });

  return ArtifactToolkit.of({
    artifact_save: (input) =>
      Effect.gen(function* () {
        const owner = yield* context;
        const name = clip(input.name, MAX_NAME_CHARS);
        const tags = normalizedTags(input.tags);
        if (!name || !validContent(input.content) || tags === null) {
          return yield* new ArtifactInputInvalidError({
            detail: `name is required, content is limited to ${MAX_CONTENT_CHARS} characters, and tags to ${MAX_TAGS}.`,
          });
        }
        const id = yield* crypto.randomUUIDv4;
        const now = new Date(yield* Clock.currentTimeMillis).toISOString();
        return yield* repository
          .create({
            id,
            slug: artifactSlug(name, id),
            projectId: owner.projectId,
            name,
            kind: input.kind,
            description:
              input.description === null || input.description === undefined
                ? null
                : clip(input.description, MAX_DESCRIPTION_CHARS),
            tags,
            content: input.content,
            sourceThreadId: owner.scope.threadId,
            createdAt: now,
          })
          .pipe(operationError("save"));
      }),
    artifact_list: () =>
      Effect.gen(function* () {
        const owner = yield* context;
        const artifacts = yield* repository.list(owner.projectId).pipe(operationError("list"));
        return { artifacts };
      }),
    artifact_get: ({ slug, version }) =>
      Effect.gen(function* () {
        const owner = yield* context;
        const artifact = yield* repository
          .get(owner.projectId, slug, version)
          .pipe(operationError("get"));
        return yield* requireArtifact(slug, artifact);
      }),
    artifact_update: (input) =>
      Effect.gen(function* () {
        const owner = yield* context;
        const current = yield* repository
          .get(owner.projectId, input.slug)
          .pipe(operationError("get"), Effect.flatMap((value) => requireArtifact(input.slug, value)));
        const tags = input.tags === undefined ? current.tags : normalizedTags(input.tags);
        if ((input.content !== undefined && !validContent(input.content)) || tags === null) {
          return yield* new ArtifactInputInvalidError({
            detail: `content is limited to ${MAX_CONTENT_CHARS} characters and tags to ${MAX_TAGS}.`,
          });
        }
        if (
          input.content === undefined && input.name === undefined && input.kind === undefined &&
          input.description === undefined && input.tags === undefined
        ) {
          return yield* new ArtifactInputInvalidError({ detail: "No artifact change supplied." });
        }
        const now = new Date(yield* Clock.currentTimeMillis).toISOString();
        const updated = yield* repository
          .update({
            projectId: owner.projectId,
            slug: input.slug,
            name: input.name === undefined ? current.name : clip(input.name, MAX_NAME_CHARS),
            kind: input.kind ?? current.kind,
            description:
              input.description === undefined
                ? current.description
                : input.description === null
                  ? null
                  : clip(input.description, MAX_DESCRIPTION_CHARS),
            tags,
            content: input.content ?? null,
            sourceThreadId: owner.scope.threadId,
            reason: input.reason ?? "updated",
            updatedAt: now,
          })
          .pipe(operationError("update"));
        return yield* requireArtifact(input.slug, updated);
      }),
    artifact_versions: ({ slug }) =>
      Effect.gen(function* () {
        const owner = yield* context;
        const versions = yield* repository
          .versions(owner.projectId, slug)
          .pipe(operationError("versions"));
        if (versions.length === 0) return yield* new ArtifactNotFoundError({ slug });
        return { versions };
      }),
    artifact_revert: ({ slug, targetVersion }) =>
      Effect.gen(function* () {
        const owner = yield* context;
        if (targetVersion < 1) {
          return yield* new ArtifactInputInvalidError({ detail: "targetVersion must be positive." });
        }
        const now = new Date(yield* Clock.currentTimeMillis).toISOString();
        const reverted = yield* repository
          .revert({
            projectId: owner.projectId,
            slug,
            targetVersion,
            sourceThreadId: owner.scope.threadId,
            updatedAt: now,
          })
          .pipe(operationError("revert"));
        return yield* requireArtifact(slug, reverted);
      }),
    artifact_delete: ({ slug }) =>
      Effect.gen(function* () {
        const owner = yield* context;
        const removed = yield* repository
          .remove(owner.projectId, slug)
          .pipe(operationError("delete"));
        return { removed };
      }),
  });
});

export const ArtifactToolkitHandlersLive = ArtifactToolkit.toLayer(make);
