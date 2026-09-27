import { ThreadId, type EnvironmentThreadWorkflow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canPauseWorkflow,
  filterAndSortWorkflows,
  restartableWorkflowSteps,
  workflowProgress,
} from "./WorkflowManagementPage.logic";

const workflow = (
  overrides: Partial<EnvironmentThreadWorkflow> & Pick<EnvironmentThreadWorkflow, "id">,
): EnvironmentThreadWorkflow => ({
  threadId: ThreadId.make("thread-1"),
  threadTitle: "Release work",
  name: "Ship release",
  status: "running",
  currentStep: 0,
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
  steps: [
    {
      index: 0,
      title: "Implement",
      prompt: "Implement the change",
      dependsOn: [],
      status: "pending",
      attempt: 1,
      result: null,
      childThreadId: null,
      worktreePath: null,
      branch: null,
      startedAt: null,
      completedAt: null,
    },
  ],
  ...overrides,
});

describe("WorkflowManagementPage logic", () => {
  it("prioritizes failed and running workflows and searches step content", () => {
    const running = workflow({ id: "running" });
    const failed = workflow({ id: "failed", status: "failed" });
    const completed = workflow({ id: "completed", status: "completed" });
    expect(
      filterAndSortWorkflows([completed, running, failed], "", "all").map(({ id }) => id),
    ).toEqual(["failed", "running", "completed"]);
    expect(filterAndSortWorkflows([running], "implement the change", "all")).toEqual([running]);
  });

  it("calculates completed progress", () => {
    const item = workflow({
      id: "progress",
      steps: [
        { ...workflow({ id: "base" }).steps[0]!, status: "completed" },
        { ...workflow({ id: "base" }).steps[0]!, index: 1 },
      ],
    });
    expect(workflowProgress(item)).toEqual({ completed: 1, total: 2, percent: 50 });
  });

  it("only exposes restart points with a completed prefix", () => {
    const item = workflow({
      id: "restart",
      steps: [
        { ...workflow({ id: "base" }).steps[0]!, status: "completed" },
        { ...workflow({ id: "base" }).steps[0]!, index: 1, status: "failed" },
        { ...workflow({ id: "base" }).steps[0]!, index: 2 },
      ],
    });
    expect(restartableWorkflowSteps(item)).toEqual([1, 2]);
  });

  it("pauses only when the current step has not started", () => {
    expect(canPauseWorkflow(workflow({ id: "pending" }))).toBe(true);
    expect(
      canPauseWorkflow(
        workflow({
          id: "running",
          steps: [{ ...workflow({ id: "base" }).steps[0]!, status: "running" }],
        }),
      ),
    ).toBe(false);
  });
});
