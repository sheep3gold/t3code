import { describe, expect, it } from "vite-plus/test";

import type { OrchestrationSession } from "@t3tools/contracts";
import { TurnId } from "@t3tools/contracts";

import { canRetryThread, THREAD_RETRY_PROMPT } from "./retryThread.ts";

const session = (
  status: "ready" | "running" | "error" | "interrupted" | "stopped",
  options: { active?: boolean; error?: string | null } = {},
): Pick<OrchestrationSession, "status" | "activeTurnId" | "lastError"> => ({
  status,
  activeTurnId: options.active ? TurnId.make("turn-1") : null,
  lastError: options.error ?? null,
});

describe("thread retry", () => {
  it("offers retry only for settled failed or interrupted work", () => {
    expect(canRetryThread({ session: session("error"), hasUserMessage: true })).toBe(true);
    expect(canRetryThread({ session: session("interrupted"), hasUserMessage: true })).toBe(true);
    expect(
      canRetryThread({
        session: session("stopped", { error: "provider disconnected" }),
        hasUserMessage: true,
      }),
    ).toBe(true);
  });

  it("does not retry active, healthy, empty, or decision-blocked threads", () => {
    expect(
      canRetryThread({ session: session("error", { active: true }), hasUserMessage: true }),
    ).toBe(false);
    expect(canRetryThread({ session: session("ready"), hasUserMessage: true })).toBe(false);
    expect(canRetryThread({ session: session("error"), hasUserMessage: false })).toBe(false);
    expect(
      canRetryThread({
        session: session("error"),
        hasUserMessage: true,
        hasPendingRequest: true,
      }),
    ).toBe(false);
  });

  it("tells the agent to preserve completed work", () => {
    expect(THREAD_RETRY_PROMPT).toContain("last confirmed step");
    expect(THREAD_RETRY_PROMPT).toContain("do not repeat work");
  });
});
