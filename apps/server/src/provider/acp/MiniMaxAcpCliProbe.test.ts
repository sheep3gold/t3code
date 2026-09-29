import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";
import { makeMiniMaxAcpRuntime } from "./MiniMaxAcpSupport.ts";
import { makeMiniMaxAdapter } from "../Layers/MiniMaxAdapter.ts";

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeMiniMaxAcpRuntime({
    minimaxSettings: {
      binaryPath: process.env.T3_MINIMAX_BINARY ?? "mcode",
      dataDir: process.env.MINIMAX_DATA_DIR ?? "",
    },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-minimax-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_MINIMAX_ACP_PROBE === "1")("MiniMax ACP CLI probe", () => {
  it.effect("starts the native MiniMax Code ACP server", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult.agentInfo?.name).toBe("minimax-code");
      expect(started.sessionId).toMatch(/^mvs_/);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("advertises all configured official models and switches model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const model = started.sessionSetupResult.configOptions?.find((item) => item.id === "model");
      expect(model?.type).toBe("select");
      if (!model || model.type !== "select") return;
      const official = model.options.flatMap((item) =>
        "value" in item && item.value.startsWith("m:custom_provider%3Aminimax-official-api:")
          ? [item.value]
          : [],
      );
      expect(official).toHaveLength(8);
      const target = official.find((value) => value.includes("MiniMax-M2.7:"));
      expect(target).toBeDefined();
      if (target) yield* runtime.setModel(target);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(process.env.T3_MINIMAX_LIVE_TURN !== "1")(
    "completes a real turn through the T3 MiniMax adapter",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("minimax");
        const threadId = ThreadId.make("minimax-live-probe");
        const adapter = yield* makeMiniMaxAdapter(
          {
            enabled: true,
            binaryPath: process.env.T3_MINIMAX_BINARY ?? "mcode",
            dataDir: process.env.MINIMAX_DATA_DIR ?? "",
            customModels: [],
          },
          { instanceId, environment: process.env },
        );
        const completed = yield* Deferred.make<void>();
        const chunks: string[] = [];
        const events = yield* Stream.runForEach(adapter.streamEvents, (event) => {
          if (event.type === "content.delta") chunks.push(event.payload.delta);
          return event.type === "turn.completed"
            ? Deferred.succeed(completed, undefined).pipe(Effect.ignore)
            : Effect.void;
        }).pipe(Effect.forkChild);
        const model = "m:custom_provider%3Aminimax-official-api:MiniMax-M3:v:thinking";
        const session = yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId, model },
        });
        expect(session.model).toBe(model);
        yield* adapter.sendTurn({
          threadId,
          input: "Reply exactly MINIMAX_T3_OK. Do not use tools.",
          modelSelection: { instanceId, model },
        });
        yield* Deferred.await(completed).pipe(Effect.timeout("90 seconds"));
        expect(chunks.join("")).toContain("MINIMAX_T3_OK");
        yield* adapter.stopSession(threadId);
        yield* Fiber.interrupt(events);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
