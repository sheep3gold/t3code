import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { ApprovalRequestId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";
import { makeFactoryAcpRuntime } from "./FactoryAcpSupport.ts";
import { makeFactoryAdapter } from "../Layers/FactoryAdapter.ts";
import { makeFactoryApiKeyResolver } from "../factoryApiKey.ts";

// Needs a real `droid` and FACTORY_API_KEY in the environment; turns spend credits.
const settings = {
  enabled: true,
  binaryPath: process.env.T3_FACTORY_BINARY ?? "droid",
  apiKeyEtcdKey: process.env.T3_FACTORY_ETCD_KEY ?? "",
  proxyUrl: "",
  customModels: [],
};

describe.runIf(process.env.T3_FACTORY_ACP_PROBE === "1")("Factory ACP CLI probe", () => {
  it.effect("starts droid over ACP and advertises the model catalog", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* makeFactoryAcpRuntime({
        factorySettings: settings,
        environment: process.env,
        childProcessSpawner,
        cwd: process.cwd(),
        clientInfo: { name: "t3-factory-probe", version: "0.0.0" },
      });
      const started = yield* runtime.start();
      expect(started.initializeResult.agentInfo?.name).toBe("@factory/cli");
      const model = started.sessionSetupResult.configOptions?.find((item) => item.id === "model");
      expect(model?.type).toBe("select");
      if (!model || model.type !== "select") return;
      expect(model.options.length).toBeGreaterThan(40);
      yield* runtime.setModel("claude-haiku-4-5-20251001");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(process.env.T3_FACTORY_LIVE_TURN !== "1")(
    "completes a turn on a non-default model and routes an approval request",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("factory");
        const threadId = ThreadId.make("factory-live-probe");
        const adapter = yield* makeFactoryAdapter(settings, {
          instanceId,
          environment: process.env,
        });
        const completed = yield* Deferred.make<void>();
        const chunks: string[] = [];
        const approvals: string[] = [];
        const events = yield* Stream.runForEach(adapter.streamEvents, (event) => {
          if (event.type === "content.delta") chunks.push(event.payload.delta);
          if (event.type === "request.opened" && event.requestId) {
            approvals.push(event.payload.requestType);
            return adapter
              .respondToRequest(threadId, ApprovalRequestId.make(event.requestId), "accept")
              .pipe(Effect.ignore);
          }
          return event.type === "turn.completed"
            ? Deferred.succeed(completed, undefined).pipe(Effect.ignore)
            : Effect.void;
        }).pipe(Effect.forkChild);
        const model = "claude-haiku-4-5-20251001";
        const session = yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          modelSelection: { instanceId, model },
        });
        expect(session.model).toBe(model);
        yield* adapter.sendTurn({
          threadId,
          input: "Run the shell command `echo FACTORY_T3_OK` and reply with its output only.",
          modelSelection: { instanceId, model },
        });
        yield* Deferred.await(completed).pipe(Effect.timeout("120 seconds"));
        expect(chunks.join("")).toContain("FACTORY_T3_OK");
        // A permission prompt must have reached T3 in approval-required mode.
        expect(approvals.length).toBeGreaterThan(0);
        yield* adapter.stopSession(threadId);
        yield* Fiber.interrupt(events);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(process.env.T3_FACTORY_LIVE_TURN !== "1")(
    "resumes a stored session, and falls back to a fresh one for a stale cursor",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("factory");
        const model = "gpt-6-luna";
        const adapter = yield* makeFactoryAdapter(settings, {
          instanceId,
          environment: process.env,
        });
        const chunks: string[] = [];
        let turnDone = yield* Deferred.make<void>();
        const events = yield* Stream.runForEach(adapter.streamEvents, (event) => {
          if (event.type === "content.delta") chunks.push(event.payload.delta);
          return event.type === "turn.completed"
            ? Deferred.succeed(turnDone, undefined).pipe(Effect.ignore)
            : Effect.void;
        }).pipe(Effect.forkChild);
        const ask = (threadId: ThreadId, input: string) =>
          Effect.gen(function* () {
            chunks.length = 0;
            turnDone = yield* Deferred.make<void>();
            yield* adapter.sendTurn({ threadId, input, modelSelection: { instanceId, model } });
            yield* Deferred.await(turnDone).pipe(Effect.timeout("90 seconds"));
            return chunks.join("");
          });

        const first = ThreadId.make("factory-resume-probe-a");
        const started = yield* adapter.startSession({
          threadId: first,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          modelSelection: { instanceId, model },
        });
        yield* ask(first, "Remember the code word HERON-77. Reply only: noted");
        yield* adapter.stopSession(first);

        const second = ThreadId.make("factory-resume-probe-b");
        yield* adapter.startSession({
          threadId: second,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          modelSelection: { instanceId, model },
          resumeCursor: started.resumeCursor,
        });
        expect(
          yield* ask(second, "What was the code word? Reply with only the code word."),
        ).toContain("HERON-77");
        yield* adapter.stopSession(second);

        const third = ThreadId.make("factory-resume-probe-c");
        const stale = yield* adapter.startSession({
          threadId: third,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          modelSelection: { instanceId, model },
          resumeCursor: { version: 1, sessionId: "00000000-0000-0000-0000-000000000000" },
        });
        expect(stale.status).toBe("ready");
        expect(yield* ask(third, "Reply with only the word: alive")).toContain("alive");
        yield* adapter.stopSession(third);
        yield* Fiber.interrupt(events);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(process.env.T3_FACTORY_LIVE_TURN !== "1")(
    "reads the API key from etcd at spawn time and follows a rotation",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("factory");
        const model = "gpt-6-luna";
        const { FACTORY_API_KEY: realKey, ...withoutKey } = process.env;
        expect(realKey).toBeTruthy();

        // 1) No key in the environment: etcd alone must carry a turn.
        const live = makeFactoryApiKeyResolver({
          etcdKey: process.env.T3_FACTORY_ETCD_KEY ?? "/droid/appkey",
          baseEnvironment: withoutKey,
          ttlMs: 0,
        });
        expect((yield* live.environment).FACTORY_API_KEY).toBe(realKey);

        // 2) Rotation: the resolver hands out a dead key first, then the real one.
        let rotated = false;
        const adapter = yield* makeFactoryAdapter(settings, {
          instanceId,
          environment: withoutKey,
          resolveEnvironment: Effect.sync(() => ({
            ...withoutKey,
            FACTORY_API_KEY: rotated ? realKey : "fk-rotated-out-key",
          })),
        });
        const chunks: string[] = [];
        let turnDone = yield* Deferred.make<void>();
        const events = yield* Stream.runForEach(adapter.streamEvents, (event) => {
          if (event.type === "content.delta") chunks.push(event.payload.delta);
          return event.type === "turn.completed"
            ? Deferred.succeed(turnDone, undefined).pipe(Effect.ignore)
            : Effect.void;
        }).pipe(Effect.forkChild);
        const threadId = ThreadId.make("factory-rotation-probe");
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          modelSelection: { instanceId, model },
        });
        rotated = true;
        chunks.length = 0;
        turnDone = yield* Deferred.make<void>();
        yield* adapter.sendTurn({
          threadId,
          input: "Reply with only the word: rotated",
          modelSelection: { instanceId, model },
        });
        yield* Deferred.await(turnDone).pipe(Effect.timeout("90 seconds"));
        expect(chunks.join("")).toContain("rotated");
        yield* adapter.stopSession(threadId);
        yield* Fiber.interrupt(events);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
