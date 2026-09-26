import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatAgentLessonContext, searchAgentMemories } from "./AgentMemory.ts";
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
});
