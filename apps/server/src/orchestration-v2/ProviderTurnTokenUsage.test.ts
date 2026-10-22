import {
  NodeId,
  type OrchestrationV2ProviderTurn,
  ProviderThreadId,
  ProviderTurnId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { upsertProviderTurn } from "./ProjectionStore.ts";

describe("provider turn token usage projection", () => {
  it("keeps live usage when a terminal update omits it", () => {
    const now = DateTime.makeUnsafe("2026-08-29T00:00:00.000Z");
    const running = {
      id: ProviderTurnId.make("provider-turn-usage"),
      providerThreadId: ProviderThreadId.make("provider-thread-usage"),
      nodeId: NodeId.make("node-usage"),
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running",
      startedAt: now,
      completedAt: null,
      tokenUsage: {
        usedTokens: 50_000,
        maxTokens: 200_000,
        updatedAt: "2026-08-29T00:00:00.000Z",
      },
    } satisfies OrchestrationV2ProviderTurn;
    const completed = {
      ...running,
      status: "completed",
      completedAt: now,
      tokenUsage: undefined,
    } satisfies OrchestrationV2ProviderTurn;

    const projected = upsertProviderTurn([running], completed);

    assert.deepEqual(projected[0]?.tokenUsage, running.tokenUsage);
    assert.equal(projected[0]?.status, "completed");
  });

  it("keeps the served model when later updates omit it", () => {
    const now = DateTime.makeUnsafe("2026-10-22T00:00:00.000Z");
    const running = {
      id: ProviderTurnId.make("provider-turn-served"),
      providerThreadId: ProviderThreadId.make("provider-thread-served"),
      nodeId: NodeId.make("node-served"),
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running",
      startedAt: now,
      completedAt: null,
      servedModel: "minimax/MiniMax-M3.1-Flash",
    } satisfies OrchestrationV2ProviderTurn;
    const usage = upsertProviderTurn([running], {
      ...running,
      servedModel: undefined,
      tokenUsage: { usedTokens: 10, updatedAt: "2026-10-22T00:00:00.000Z" },
    });
    assert.equal(usage[0]?.servedModel, "minimax/MiniMax-M3.1-Flash");
    const rerouted = upsertProviderTurn(usage, { ...running, servedModel: "glm/glm-5.3" });
    assert.equal(rerouted[0]?.servedModel, "glm/glm-5.3");
  });
});
