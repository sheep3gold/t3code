import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ApprovalRequestId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as SecretRequests from "./SecretRequests.ts";

const threadId = ThreadId.make("thread-1");
const requestId = ApprovalRequestId.make("secret-request:thread-1:req-1");
const projectId = ProjectId.make("project-1");

const requestedActivity = (rid: string = requestId) => ({
  kind: "user-input.requested",
  turnId: "turn-1",
  payload: {
    requestId: rid,
    responseMode: "message",
    secretRequest: true,
    label: "GitHub token",
    reason: "Used as GH_TOKEN.",
    questions: [],
  },
});

/** Runs `body` against the service with an in-memory store and a thread holding one request. */
const withService = <A, E>(
  body: (input: {
    readonly service: SecretRequests.SecretRequests["Service"];
    readonly stored: Map<string, Uint8Array>;
    readonly dispatched: Array<{ readonly type: string; readonly activity?: unknown }>;
  }) => Effect.Effect<A, E>,
  options: {
    /** Activity list the thread reports; defaults to one pending secret request. */
    readonly activities?: ReadonlyArray<unknown>;
    readonly turnState?: string;
    readonly removeFails?: boolean;
    /** How many record dispatches fail before one succeeds. */
    readonly failedRecords?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>();
    const dispatched: Array<{ readonly type: string; readonly activity?: unknown }> = [];
    let failedRecords = options.failedRecords ?? 0;
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      NodeServices.layer,
      Layer.succeed(
        ServerConfig.ServerConfig,
        ServerConfig.ServerConfig.of({ secretsDir: "/tmp/secret-requests-test" } as never),
      ),
      Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          // Yields like a real file read, so concurrent callers can interleave.
          get: (name: string) =>
            Effect.yieldNow.pipe(Effect.as(Option.fromNullishOr(stored.get(name)))),
          set: (name: string, value: Uint8Array) => Effect.sync(() => void stored.set(name, value)),
          create: (name: string, value: Uint8Array) =>
            stored.has(name)
              ? Effect.fail(
                  new ServerSecretStore.SecretStorePersistError({
                    resource: name,
                    cause: new PlatformError.PlatformError(
                      new PlatformError.SystemError({
                        _tag: "AlreadyExists",
                        module: "FileSystem",
                        method: "open",
                      }),
                    ),
                  } as never),
                )
              : Effect.sync(() => void stored.set(name, value)),
          getOrCreateRandom: (name: string, bytes: number) =>
            Effect.sync(() => {
              const existing = stored.get(name);
              if (existing) return existing;
              const value = new Uint8Array(bytes).fill(7);
              stored.set(name, value);
              return value;
            }),
          remove: (name: string) =>
            options.removeFails
              ? Effect.fail(
                  new ServerSecretStore.SecretStorePersistError({
                    resource: name,
                    cause: new Error("read-only"),
                  }),
                )
              : Effect.sync(() => void stored.delete(name)),
        } as never),
      ),
      Layer.succeed(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        ProjectionSnapshotQuery.ProjectionSnapshotQuery.of({
          getThreadDetailById: () =>
            Effect.succeed(
              Option.some({
                projectId,
                latestTurn: { state: options.turnState ?? "running" },
                activities: options.activities ?? [requestedActivity()],
              }),
            ),
        } as never),
      ),
      Layer.succeed(
        OrchestrationEngine.OrchestrationEngineService,
        OrchestrationEngine.OrchestrationEngineService.of({
          dispatch: (command: { readonly type: string }) => {
            if (command.type === "thread.activity.append" && failedRecords > 0) {
              failedRecords -= 1;
              return Effect.fail(new Error("engine unavailable") as never);
            }
            return Effect.sync(() => {
              dispatched.push(command as never);
              return {} as never;
            });
          },
        } as never),
      ),
    );
    return yield* Effect.gen(function* () {
      const service = yield* SecretRequests.SecretRequests;
      return yield* body({ service, stored, dispatched });
    }).pipe(Effect.provide(SecretRequests.layer.pipe(Layer.provide(dependencies))));
  });

/** The secret values in the store, leaving out the server's own salt. */
const valuesOf = (stored: Map<string, Uint8Array>) =>
  Array.from(stored.entries())
    .filter(([name]) => name !== "secret-request-salt")
    .map(([, bytes]) => new TextDecoder().decode(bytes));

it.effect("a saved answer becomes a one-use ref, and the thread only learns it was saved", () =>
  withService(({ service, stored, dispatched }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        requestId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0]!.type, "thread.activity.append");
      const activity = dispatched[0]!.activity as { payload: Record<string, unknown> };
      assert.equal(activity.payload["secretStatus"], "saved");
      // The value never crosses the wire into the thread record: no payload
      // field holds the typed value.
      for (const value of Object.values(activity.payload)) {
        assert.notStrictEqual(value, "ghp_secret");
      }

      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, requestId }));
      assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
      // Used once: the value is gone from the store and the ref fails.
      assert.isFalse(valuesOf(stored).some((value) => value.includes("ghp_secret")));
      const again = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
      assert.equal(again.reason, "ref_unavailable");
    }),
  ),
);

it.effect("two concurrent uses of one ref hand the value out once", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        requestId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, requestId }));
      const results = yield* Effect.all(
        [service.consume({ ref, projectId }), service.consume({ ref, projectId })].map(
          Effect.result,
        ),
        { concurrency: "unbounded" },
      );
      assert.deepEqual(results.map((result) => result._tag).toSorted(), ["Failure", "Success"]);
    }),
  ),
);

it.effect("a second answer after the card resolved is refused", () => {
  const resolved = {
    kind: "user-input.resolved",
    turnId: "turn-1",
    payload: { requestId, responseMode: "message", secretStatus: "declined" },
  };
  return withService(
    ({ service }) =>
      Effect.gen(function* () {
        const error = yield* service
          .answer({ threadId, requestId, answer: { type: "decline" } })
          .pipe(Effect.flip);
        assert.equal(error.reason, "already_answered");
      }),
    { activities: [requestedActivity(), resolved] },
  );
});

it.effect("an answer on a thread whose turn ended is refused as agent_stopped", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        const error = yield* service
          .answer({ threadId, requestId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.equal(error.reason, "agent_stopped");
      }),
    { turnState: "completed" },
  ),
);

it.effect("a save whose record failed can be saved again", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        const failed = yield* service
          .answer({ threadId, requestId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.equal(failed.reason, "record_failed");
        yield* service.answer({
          threadId,
          requestId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, requestId }));
        assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
      }),
    { failedRecords: 1 },
  ),
);

it.effect("a save whose record failed has its value cleaned up", () =>
  withService(
    ({ service, stored }) =>
      Effect.gen(function* () {
        yield* service
          .answer({ threadId, requestId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.isFalse(valuesOf(stored).some((value) => value.includes("ghp_secret")));
      }),
    { failedRecords: 1 },
  ),
);

it.effect("a declined answer records the decline and stores nothing", () =>
  withService(({ service, stored, dispatched }) =>
    Effect.gen(function* () {
      yield* service.answer({ threadId, requestId, answer: { type: "decline" } });
      assert.equal(dispatched.length, 1);
      const activity = dispatched[0]!.activity as { payload: Record<string, unknown> };
      assert.equal(activity.payload["secretStatus"], "declined");
      assert.equal(stored.has("secret-request-salt"), true);
      assert.equal(
        Array.from(stored.keys()).filter((name) => name !== "secret-request-salt").length,
        0,
      );
    }),
  ),
);

it.effect("an unknown request id is not_found", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const error = yield* service
        .answer({
          threadId,
          requestId: ApprovalRequestId.make("secret-request:thread-1:missing"),
          answer: { type: "decline" },
        })
        .pipe(Effect.flip);
      assert.equal(error.reason, "not_found");
    }),
  ),
);

it.effect("a malformed ref is refused before touching the store", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const error = yield* service
        .consume({
          ref: "secret-ref:not-hex" as never,
          projectId,
        })
        .pipe(Effect.flip);
      assert.equal(error.reason, "invalid_ref");
    }),
  ),
);

it.effect("a ref entered for another project is refused", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        requestId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, requestId }));
      const error = yield* service
        .consume({ ref, projectId: ProjectId.make("project-2") })
        .pipe(Effect.flip);
      assert.equal(error.reason, "ref_unavailable");
    }),
  ),
);
