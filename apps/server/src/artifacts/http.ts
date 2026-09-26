import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as Artifacts from "../persistence/Artifacts.ts";

export const artifactsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "artifacts",
  Effect.fnUntraced(function* (handlers) {
    const repository = yield* Artifacts.ArtifactRepository;
    const readScope = (endpoint: string) =>
      annotateEnvironmentRequest(endpoint).pipe(
        Effect.andThen(requireEnvironmentScope(AuthOrchestrationReadScope)),
      );
    const internal = (cause: unknown) => failEnvironmentInternal("internal_error", cause);

    return handlers
      .handle(
        "list",
        Effect.fn("environment.artifacts.list")(function* (args) {
          yield* readScope(args.endpoint.name);
          const artifacts = yield* repository.list(args.payload.projectId).pipe(
            Effect.catch(internal),
          );
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
      );
  }),
);
