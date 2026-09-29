import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as Artifacts from "../persistence/Artifacts.ts";

const MAX_CONTENT_CHARS = 200_000;
const MAX_TAGS = 16;

export const artifactsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "artifacts",
  Effect.fnUntraced(function* (handlers) {
    const repository = yield* Artifacts.ArtifactRepository;
    const readScope = (endpoint: string) =>
      annotateEnvironmentRequest(endpoint).pipe(
        Effect.andThen(requireEnvironmentScope(AuthOrchestrationReadScope)),
      );
    const operateScope = (endpoint: string) =>
      annotateEnvironmentRequest(endpoint).pipe(
        Effect.andThen(requireEnvironmentScope(AuthOrchestrationOperateScope)),
      );
    const internal = (cause: unknown) => failEnvironmentInternal("internal_error", cause);

    return handlers
      .handle(
        "list",
        Effect.fn("environment.artifacts.list")(function* (args) {
          yield* readScope(args.endpoint.name);
          const artifacts = yield* repository
            .list(args.payload.projectId)
            .pipe(Effect.catch(internal));
          return { artifacts };
        }),
      )
      .handle(
        "get",
        Effect.fn("environment.artifacts.get")(function* (args) {
          yield* readScope(args.endpoint.name);
          const artifact = yield* repository
            .get(args.payload.projectId, args.params.slug, args.payload.version)
            .pipe(Effect.catch(internal));
          if (Option.isNone(artifact)) return yield* failEnvironmentNotFound("artifact_not_found");
          return artifact.value;
        }),
      )
      .handle(
        "versions",
        Effect.fn("environment.artifacts.versions")(function* (args) {
          yield* readScope(args.endpoint.name);
          const versions = yield* repository
            .versions(args.payload.projectId, args.params.slug)
            .pipe(Effect.catch(internal));
          if (versions.length === 0) return yield* failEnvironmentNotFound("artifact_not_found");
          return { versions };
        }),
      )
      .handle(
        "update",
        Effect.fn("environment.artifacts.update")(function* (args) {
          yield* operateScope(args.endpoint.name);
          const current = yield* repository
            .get(args.payload.projectId, args.params.slug)
            .pipe(Effect.catch(internal));
          if (Option.isNone(current)) return yield* failEnvironmentNotFound("artifact_not_found");
          const tags = args.payload.tags ?? current.value.tags;
          if (
            tags.length > MAX_TAGS ||
            (args.payload.content !== undefined &&
              Array.from(args.payload.content).length > MAX_CONTENT_CHARS)
          ) {
            return yield* failEnvironmentInvalidRequest("invalid_artifact");
          }
          const updated = yield* repository
            .update({
              projectId: args.payload.projectId,
              slug: args.params.slug,
              name: args.payload.name ?? current.value.name,
              kind: args.payload.kind ?? current.value.kind,
              description:
                args.payload.description === undefined
                  ? current.value.description
                  : args.payload.description,
              tags,
              content: args.payload.content ?? null,
              sourceThreadId: current.value.sourceThreadId,
              reason: args.payload.reason ?? "updated from library",
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            })
            .pipe(Effect.catch(internal));
          if (Option.isNone(updated)) return yield* failEnvironmentNotFound("artifact_not_found");
          return updated.value;
        }),
      )
      .handle(
        "revert",
        Effect.fn("environment.artifacts.revert")(function* (args) {
          yield* operateScope(args.endpoint.name);
          const current = yield* repository
            .get(args.payload.projectId, args.params.slug)
            .pipe(Effect.catch(internal));
          if (Option.isNone(current)) return yield* failEnvironmentNotFound("artifact_not_found");
          const reverted = yield* repository
            .revert({
              projectId: args.payload.projectId,
              slug: args.params.slug,
              targetVersion: args.payload.targetVersion,
              sourceThreadId: current.value.sourceThreadId,
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            })
            .pipe(Effect.catch(internal));
          if (Option.isNone(reverted)) return yield* failEnvironmentNotFound("artifact_not_found");
          return reverted.value;
        }),
      )
      .handle(
        "remove",
        Effect.fn("environment.artifacts.remove")(function* (args) {
          yield* operateScope(args.endpoint.name);
          return {
            removed: yield* repository
              .remove(args.payload.projectId, args.params.slug)
              .pipe(Effect.catch(internal)),
          };
        }),
      );
  }),
);
