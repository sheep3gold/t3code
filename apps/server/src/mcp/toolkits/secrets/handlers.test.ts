import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  SecretRef,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { Tool } from "effect/unstable/ai";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import { SecretsToolkitHandlersLive } from "./handlers.ts";
import { SecretsToolkit } from "./secretTools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set<McpInvocationContext.McpCapability>(),
  issuedAt: 1,
});

interface CardActivity {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

const pendingCard = (requestId: string): CardActivity => ({
  kind: "user-input.requested",
  payload: { requestId, responseMode: "message", secretRequest: true },
});

const resolvedCard = (requestId: string, secretStatus: string): CardActivity => ({
  kind: "user-input.resolved",
  payload: { requestId, responseMode: "message", secretStatus },
});

interface HarnessOptions {
  /**
   * Activities the thread reports. A function lets the list change between
   * polls, e.g. the pending card the handler just recorded becoming visible.
   */
  readonly activities: Array<CardActivity> | (() => Array<CardActivity>);
  readonly turnState?: string;
}

const makeHarness = Effect.fn("makeSecretsToolkitHarness")(function* (options: HarnessOptions) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      return { sequence: 1 };
    });
  const activitiesOf = () =>
    typeof options.activities === "function" ? options.activities() : options.activities;
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadDetailById: (threadId) =>
        Effect.succeed(
          threadId === THREAD_ID
            ? Option.some({
                projectId: PROJECT_ID,
                latestTurn: { turnId: "turn-1", state: options.turnState ?? "running" },
                session: null,
                activities: activitiesOf(),
              } as never)
            : Option.none(),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
    Layer.mock(SecretRequests.SecretRequests)({
      savedRef: () => Effect.succeed(Option.some(SecretRef.make(`secret-ref:${"a".repeat(32)}`))),
    }),
  );
  const toolkit = yield* SecretsToolkit.pipe(
    Effect.provide(SecretsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = (
    params: Parameters<typeof toolkit.handle<"request_secret">>[1],
  ): Effect.Effect<Tool.Success<(typeof SecretsToolkit.tools)["request_secret"]>, never> =>
    toolkit.handle("request_secret", params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) =>
          chunk.at(-1)!.result as Tool.Success<(typeof SecretsToolkit.tools)["request_secret"]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation()),
      Effect.provide(dependencies),
    );
  return { commands, call };
});

const baseInput = {
  label: "GitHub token",
  reason: "Used as GH_TOKEN.",
  timeoutMs: 2_000,
} as const;

describe("secrets toolkit handlers", () => {
  it.effect("opens one card and returns the ref when the user saved", () =>
    Effect.gen(function* () {
      const requestId = `secret-request:${THREAD_ID}:retry-1`;
      const harness = yield* makeHarness({
        activities: [pendingCard(requestId), resolvedCard(requestId, "saved")],
      });
      const result = yield* harness.call({ ...baseInput, clientRequestId: "retry-1" });
      expect(result.status).toBe("saved");
      expect((result as { secretRef: string }).secretRef).toMatch(/^secret-ref:[0-9a-f]{32}$/);
      // The card already existed answered: no new record was dispatched.
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("records a pending card for a fresh request", () =>
    Effect.gen(function* () {
      const requestId = `secret-request:${THREAD_ID}:fresh-1`;
      // First load: nothing yet; after the handler records the card, the
      // thread shows it pending, then declined.
      let phase = 0;
      const harness = yield* makeHarness({
        activities: () => {
          phase += 1;
          if (phase <= 1) return [];
          if (phase === 2) return [pendingCard(requestId)];
          return [pendingCard(requestId), resolvedCard(requestId, "declined")];
        },
      });
      const fiber = yield* harness
        .call({ ...baseInput, clientRequestId: "fresh-1" })
        .pipe(Effect.forkChild);
      // Let the handler's polls run on the test clock.
      yield* TestClock.adjust("10 seconds");
      const result = yield* Effect.scoped(Fiber.join(fiber));
      expect(result.status).toBe("declined");
      const appended = (yield* Ref.get(harness.commands)).filter(
        (command) => command.type === "thread.activity.append",
      );
      expect(appended).toHaveLength(1);
      expect(
        (appended[0] as { activity: { payload: Record<string, unknown> } }).activity.payload[
          "secretRequest"
        ],
      ).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("returns declined without handing out a ref", () =>
    Effect.gen(function* () {
      const requestId = `secret-request:${THREAD_ID}:req-decline`;
      const harness = yield* makeHarness({
        activities: [pendingCard(requestId), resolvedCard(requestId, "declined")],
      });
      const result = yield* harness.call({ ...baseInput, clientRequestId: "req-decline" });
      expect(result.status).toBe("declined");
    }),
  );

  it.effect("closes the card and reports timed_out when nobody answers", () =>
    Effect.gen(function* () {
      const requestId = `secret-request:${THREAD_ID}:req-timeout`;
      // The card the handler records shows up pending and never resolves.
      const harness = yield* makeHarness({
        activities: () => [pendingCard(requestId)],
      });
      const fiber = yield* harness
        .call({ ...baseInput, clientRequestId: "req-timeout", timeoutMs: 1_000 })
        .pipe(Effect.forkChild);
      // Past the wait timeout; polls and the timeout itself share the test clock.
      yield* TestClock.adjust("10 seconds");
      const result = yield* Effect.scoped(Fiber.join(fiber));
      expect(result.status).toBe("timed_out");
      const appended = (yield* Ref.get(harness.commands)).filter(
        (command) => command.type === "thread.activity.append",
      );
      // The close marks the card cancelled so it cannot be answered later.
      expect(
        appended.some(
          (command) =>
            (command as { activity: { payload: Record<string, unknown> } }).activity.payload[
              "secretStatus"
            ] === "cancelled",
        ),
      ).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("refuses to ask on a thread whose turn has ended", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ activities: [], turnState: "completed" });
      // No session either: nothing will ever answer. failureMode "return"
      // delivers the error as the tool result, not on the error channel.
      const result = yield* harness.call(baseInput);
      expect(result).toMatchObject({ _tag: "RequestSecretUnavailableError" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("a retry with the same clientRequestId reuses the card instead of duplicating it", () =>
    Effect.gen(function* () {
      const requestId = `secret-request:${THREAD_ID}:retry-2`;
      const harness = yield* makeHarness({
        activities: [pendingCard(requestId), resolvedCard(requestId, "saved")],
      });
      const result = yield* harness.call({ ...baseInput, clientRequestId: "retry-2" });
      expect(result.status).toBe("saved");
      // The card already existed: no new pending record was dispatched.
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );
});
