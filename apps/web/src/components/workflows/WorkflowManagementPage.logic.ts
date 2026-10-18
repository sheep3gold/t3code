import type { EnvironmentThreadWorkflow } from "@t3tools/contracts";

export type WorkflowStatusFilter = "all" | EnvironmentThreadWorkflow["status"];

const STATUS_ORDER: Record<EnvironmentThreadWorkflow["status"], number> = {
  failed: 0,
  running: 1,
  paused: 2,
  completed: 3,
  cancelled: 4,
};

export function filterAndSortWorkflows(
  workflows: ReadonlyArray<EnvironmentThreadWorkflow>,
  query: string,
  status: WorkflowStatusFilter,
): ReadonlyArray<EnvironmentThreadWorkflow> {
  const normalized = query.trim().toLocaleLowerCase();
  return workflows
    .filter((workflow) => status === "all" || workflow.status === status)
    .filter((workflow) => {
      if (!normalized) return true;
      return [
        workflow.name,
        workflow.threadTitle,
        ...workflow.steps.flatMap((step) => [step.title, step.prompt]),
      ].some((value) => value.toLocaleLowerCase().includes(normalized));
    })
    .toSorted((left, right) => {
      const statusDifference = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
      if (statusDifference !== 0) return statusDifference;
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    });
}

export function workflowProgress(workflow: EnvironmentThreadWorkflow): {
  readonly completed: number;
  readonly total: number;
  readonly percent: number;
} {
  const total = workflow.steps.length;
  const completed = workflow.steps.filter((step) => step.status === "completed").length;
  return { completed, total, percent: total === 0 ? 0 : Math.round((completed / total) * 100) };
}

export function restartableWorkflowSteps(
  workflow: EnvironmentThreadWorkflow,
): ReadonlyArray<number> {
  const restartable: number[] = [];
  for (const step of workflow.steps) {
    if (workflow.steps.slice(0, step.index).some((prefix) => prefix.status !== "completed")) break;
    restartable.push(step.index + 1);
  }
  return restartable;
}

export function canPauseWorkflow(workflow: EnvironmentThreadWorkflow): boolean {
  return (
    workflow.status === "running" && workflow.steps[workflow.currentStep]?.status === "pending"
  );
}
