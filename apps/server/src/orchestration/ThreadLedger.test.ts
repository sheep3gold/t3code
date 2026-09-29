import { describe, expect, it } from "vite-plus/test";

import { formatThreadLedgerContext } from "./ThreadLedger.ts";

describe("ThreadLedger context", () => {
  it("renders durable state and recent events for the next provider turn", () => {
    const context = formatThreadLedgerContext({
      state: {
        goal: "Ship the feature",
        phase: "awaiting-ci",
        next: "Read the latest CI result",
        artifacts: { branch: "feat/x", pr: "https://example.test/pr/1" },
        updatedAt: "2026-09-26T12:00:00.000Z",
      },
      events: [
        {
          id: 1,
          kind: "progress",
          message: "Focused tests passed",
          createdAt: "2026-09-26T11:59:00.000Z",
        },
      ],
    });
    expect(context).toContain("Goal: Ship the feature");
    expect(context).toContain("Phase: awaiting-ci");
    expect(context).toContain("Artifact branch: feat/x");
    expect(context).toContain("[progress] Focused tests passed");
  });

  it("omits empty ledgers and bounds injected context", () => {
    expect(formatThreadLedgerContext({ state: null, events: [] })).toBe("");
    const context = formatThreadLedgerContext({
      state: {
        goal: "x".repeat(10_000),
        phase: null,
        next: null,
        artifacts: {},
        updatedAt: "2026-09-26T12:00:00.000Z",
      },
      events: [],
    });
    expect(Array.from(context).length).toBeLessThanOrEqual(6_000);
  });
});
