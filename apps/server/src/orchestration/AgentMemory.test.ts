// @effect-diagnostics nodeBuiltinImport:off -- a real loopback HTTP server stands in for memsearch.
import * as Http from "node:http";

import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { formatAgentLessonContext, rankAgentMemories, searchAgentMemories } from "./AgentMemory.ts";
import type { AgentMemory } from "../persistence/AgentMemories.ts";

const memory = (id: string, content: string, tags: ReadonlyArray<string> = []): AgentMemory => ({
  id,
  kind: "memory",
  scope: "project",
  projectId: ProjectId.make("project-1"),
  content,
  negative: null,
  tags,
  sourceThreadId: ThreadId.make("thread-1"),
  createdAt: "2026-09-26T12:00:00.000Z",
  updatedAt: "2026-09-26T12:00:00.000Z",
});

describe("AgentMemory", () => {
  it("ranks exact phrases before token-only and unrelated candidates", () => {
    const candidates = [
      memory("recent-token", "Release checks should be focused", ["validation"]),
      memory("exact", "Always run focused tests before release"),
      memory("unrelated", "Use dark mode"),
    ];
    expect(searchAgentMemories(candidates, "focused tests", 10).map((entry) => entry.id)).toEqual([
      "exact",
      "recent-token",
    ]);
  });

  it("formats lessons with negative guidance and bounds injected context", () => {
    const lesson = {
      ...memory("lesson", "Run targeted tests"),
      kind: "lesson" as const,
      negative: "Do not run the full suite",
    };
    const context = formatAgentLessonContext([lesson]);
    expect(context).toContain("Run targeted tests");
    expect(context).toContain("Avoid: Do not run the full suite");
    expect(
      Array.from(formatAgentLessonContext([{ ...lesson, content: "x".repeat(10_000) }])).length,
    ).toBeLessThanOrEqual(6_000);
  });

  describe("rankAgentMemories", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const candidates = [
      memory("keyword", "Always run focused tests before release"),
      memory("semantic", "Ship only after the targeted suite is green"),
      memory("low-score", "Use dark mode"),
    ];

    it("falls back to keyword ranking when memsearch is not configured", async () => {
      vi.stubEnv("T3CODE_MEMSEARCH_URL", "");
      const ranked = await Effect.runPromise(rankAgentMemories(candidates, "focused tests", 10));
      expect(ranked.map((entry) => entry.id)).toEqual(["keyword"]);
    });

    it("puts semantic hits first, drops low scores and unknown ids, then adds keyword hits", async () => {
      const server = Http.createServer((request, response) => {
        expect(request.headers.authorization).toBe("Bearer test-key");
        expect(request.url).toBe("/v1/records/search");
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            results: [
              { score: 0.9, record: { id: "semantic" } },
              { score: 0.8, record: { id: "not-visible" } },
              { score: 0.7, record: { id: "keyword" } },
              { score: 0.1, record: { id: "low-score" } },
            ],
          }),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as { port: number };
      vi.stubEnv("T3CODE_MEMSEARCH_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("T3CODE_MEMSEARCH_API_KEY", "test-key");
      // The mirror refuses to talk to memory-api under vitest unless a test opts in.
      vi.stubEnv("T3CODE_MEMSEARCH_IN_TESTS", "1");
      try {
        const ranked = await Effect.runPromise(rankAgentMemories(candidates, "focused tests", 10));
        expect(ranked.map((entry) => entry.id)).toEqual(["semantic", "keyword"]);
      } finally {
        server.close();
      }
    });

    it("falls back to keyword ranking when memsearch is unreachable", async () => {
      vi.stubEnv("T3CODE_MEMSEARCH_URL", "http://127.0.0.1:9");
      vi.stubEnv("T3CODE_MEMSEARCH_API_KEY", "test-key");
      const ranked = await Effect.runPromise(rankAgentMemories(candidates, "focused tests", 10));
      expect(ranked.map((entry) => entry.id)).toEqual(["keyword"]);
    });
  });
});
