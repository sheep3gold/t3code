import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadWorkflow, WorkflowStep } from "../persistence/ThreadWorkflows.ts";
import { readyWorkflowSteps } from "./ThreadWorkflows.ts";

const step = (
  index: number,
  dependsOn: ReadonlyArray<number>,
  status: WorkflowStep["status"] = "pending",
): WorkflowStep => ({
  index,
  title: `Step ${index + 1}`,
  prompt: "Do work",
  dependsOn,
  status,
  attempt: 1,
  result: null,
  childThreadId: null,
  worktreePath: null,
  branch: null,
  startedAt: null,
  completedAt: null,
});

const workflow = (steps: ReadonlyArray<WorkflowStep>): ThreadWorkflow => ({
  id: "dag",
  threadId: ThreadId.make("owner"),
  name: "DAG",
  status: "running",
  currentStep: 0,
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
  steps,
});

describe("readyWorkflowSteps", () => {
  it("releases independent roots together", () => {
    const value = workflow([step(0, []), step(1, []), step(2, [0, 1])]);
    expect(readyWorkflowSteps(value).map(({ index }) => index)).toEqual([0, 1]);
  });

  it("releases a join only after every dependency completes", () => {
    expect(
      readyWorkflowSteps(
        workflow([step(0, [], "completed"), step(1, [], "running"), step(2, [0, 1])]),
      ),
    ).toEqual([]);
    expect(
      readyWorkflowSteps(
        workflow([step(0, [], "completed"), step(1, [], "completed"), step(2, [0, 1])]),
      ).map(({ index }) => index),
    ).toEqual([2]);
  });
});
