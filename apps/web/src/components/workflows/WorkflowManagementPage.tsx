import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadWorkflow } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleXIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkflows, workflowEnvironment } from "../../state/workflows";
import {
  canPauseWorkflow,
  filterAndSortWorkflows,
  restartableWorkflowSteps,
  workflowProgress,
  type WorkflowStatusFilter,
} from "./WorkflowManagementPage.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Textarea } from "../ui/textarea";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

const STATUS_FILTERS = ["all", "running", "paused", "failed", "completed", "cancelled"] as const;
const STATUS_LABEL: Record<EnvironmentThreadWorkflow["status"], string> = {
  running: "Running",
  paused: "Paused",
  failed: "Failed",
  completed: "Completed",
  cancelled: "Cancelled",
};
const STATUS_VARIANT: Record<
  EnvironmentThreadWorkflow["status"],
  "info" | "warning" | "error" | "success" | "outline"
> = {
  running: "info",
  paused: "warning",
  failed: "error",
  completed: "success",
  cancelled: "outline",
};

let workflowDraftStepSequence = 0;
const nextWorkflowDraftStepKey = () => `workflow-step-${++workflowDraftStepSequence}`;

type WorkflowDraftStep = {
  readonly key: string;
  readonly title: string;
  readonly prompt: string;
  readonly dependsOn: string;
};

function environmentProjectKey(project: EnvironmentProject): string {
  return scopedProjectKey({ environmentId: project.environmentId, projectId: project.id });
}

function formatDate(value: string | null): string {
  if (value === null) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The workflow operation failed.";
}

function ProjectPicker({
  projects,
  value,
  onChange,
}: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly value: string;
  readonly onChange: (key: string) => void;
}) {
  const environments = useEnvironments().environments;
  const labels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const selected = projects.find((project) => environmentProjectKey(project) === value);
  return (
    <Select value={value} onValueChange={(next) => next && onChange(next)}>
      <SelectTrigger
        aria-label="Workflow project"
        size="compact"
        variant="ghost"
        className="w-auto min-w-0"
      >
        <SelectValue>
          {selected
            ? `${selected.title} · ${labels.get(selected.environmentId) ?? "Environment"}`
            : "Choose project"}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        {projects.map((project) => (
          <SelectItem key={environmentProjectKey(project)} value={environmentProjectKey(project)}>
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{project.title}</span>
              <span className="truncate text-xs text-muted-foreground">
                {labels.get(project.environmentId) ?? "Environment"}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function CreateWorkflowDialog({
  open,
  onOpenChange,
  project,
  threads,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly project: EnvironmentProject;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const createWorkflow = useAtomCommand(workflowEnvironment.create, { reportFailure: false });
  const [threadId, setThreadId] = useState(threads[0]?.id ?? "");
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<ReadonlyArray<WorkflowDraftStep>>([
    { key: nextWorkflowDraftStepKey(), title: "", prompt: "", dependsOn: "" },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const updateStep = (key: string, patch: Partial<WorkflowDraftStep>) => {
    setSteps((current) => current.map((step) => (step.key === key ? { ...step, ...patch } : step)));
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedSteps = steps.map((step) => {
      const dependsOn = step.dependsOn
        .split(",")
        .map((value) => Number(value.trim()) - 1)
        .filter((value) => Number.isInteger(value));
      return {
        title: step.title.trim(),
        prompt: step.prompt.trim(),
        ...(step.dependsOn.trim() ? { dependsOn } : {}),
      };
    });
    if (
      !threadId ||
      !name.trim() ||
      normalizedSteps.some(
        (step, index) =>
          !step.title ||
          !step.prompt ||
          step.dependsOn?.some((dependency) => dependency < 0 || dependency >= index),
      )
    ) {
      setError("Choose a thread and complete the workflow name, step titles, and instructions.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await createWorkflow({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        threadId: threadId as EnvironmentThreadShell["id"],
        name: name.trim(),
        steps: normalizedSteps,
      },
    });
    setSubmitting(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        setError(errorMessage(squashAtomCommandFailure(result)));
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Create workflow</DialogTitle>
            <DialogDescription>
              Each step runs as a separate agent turn on the selected thread.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Thread
              <Select value={threadId} onValueChange={(value) => value && setThreadId(value)}>
                <SelectTrigger aria-label="Workflow thread">
                  <SelectValue placeholder="Choose a thread" />
                </SelectTrigger>
                <SelectPopup>
                  {threads.map((thread) => (
                    <SelectItem key={thread.id} value={thread.id}>
                      {thread.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Workflow name
              <Input
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                placeholder="Ship release"
              />
            </label>
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Steps</span>
                <Button
                  disabled={steps.length >= 20}
                  onClick={() =>
                    setSteps((current) => [
                      ...current,
                      { key: nextWorkflowDraftStepKey(), title: "", prompt: "", dependsOn: "" },
                    ])
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <PlusIcon /> Add step
                </Button>
              </div>
              {steps.map((step, index) => (
                <fieldset className="rounded-lg border border-border/70 p-3" key={step.key}>
                  <legend className="px-1 text-xs font-medium text-muted-foreground">
                    Step {index + 1}
                  </legend>
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label={`Step ${index + 1} title`}
                        maxLength={120}
                        onChange={(event) =>
                          updateStep(step.key, { title: event.currentTarget.value })
                        }
                        placeholder="Implement"
                        value={step.title}
                      />
                      <Button
                        aria-label={`Remove step ${index + 1}`}
                        disabled={steps.length === 1}
                        onClick={() =>
                          setSteps((current) =>
                            current.filter((candidate) => candidate.key !== step.key),
                          )
                        }
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        <XIcon />
                      </Button>
                    </div>
                    <Input
                      aria-label={`Step ${index + 1} dependencies`}
                      onChange={(event) =>
                        updateStep(step.key, { dependsOn: event.currentTarget.value })
                      }
                      placeholder={
                        index === 0 ? "No dependencies" : "Depends on steps: 1, 2 or none"
                      }
                      value={step.dependsOn}
                    />
                    <Textarea
                      aria-label={`Step ${index + 1} instructions`}
                      maxLength={10_000}
                      onChange={(event) =>
                        updateStep(step.key, { prompt: event.currentTarget.value })
                      }
                      placeholder="Implement the approved change and run targeted tests."
                      size="sm"
                      value={step.prompt}
                    />
                  </div>
                </fieldset>
              ))}
            </div>
            {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose disabled={submitting} render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button disabled={submitting || threads.length === 0} type="submit">
              {submitting ? "Creating…" : "Create workflow"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function WorkflowList({
  workflows,
  selectedId,
  onSelect,
  onCreate,
  refresh,
}: {
  readonly workflows: ReadonlyArray<EnvironmentThreadWorkflow>;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onCreate: () => void;
  readonly refresh: () => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<WorkflowStatusFilter>("all");
  const filtered = useMemo(
    () => filterAndSortWorkflows(workflows, query, status),
    [workflows, query, status],
  );
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/16 md:max-w-80 md:border-r md:border-border/70 lg:max-w-96">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border/70 p-3">
        <div className="flex items-center gap-2">
          <Input
            aria-label="Search workflows"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search workflows"
            size="compact"
            type="search"
            value={query}
          />
          <Button aria-label="Refresh workflows" onClick={refresh} size="icon-sm" variant="ghost">
            <RefreshCwIcon />
          </Button>
          <Button aria-label="Create workflow" onClick={onCreate} size="icon-sm">
            <PlusIcon />
          </Button>
        </div>
        <Select
          value={status}
          onValueChange={(value) => value && setStatus(value as WorkflowStatusFilter)}
        >
          <SelectTrigger aria-label="Filter workflow status" size="compact">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {STATUS_FILTERS.map((value) => (
              <SelectItem key={value} value={value}>
                {value === "all" ? "All statuses" : STATUS_LABEL[value]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <ScrollArea className="min-h-0 flex-1" radius="none">
        {filtered.length === 0 ? (
          <Empty size="compact">
            <EmptyMedia variant="icon">
              <WorkflowIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>{workflows.length === 0 ? "No workflows yet" : "No matches"}</EmptyTitle>
              <EmptyDescription>
                {workflows.length === 0
                  ? "Create a workflow to run durable agent steps."
                  : "Try another search or status."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-1 p-2" role="listbox" aria-label="Workflows">
            {filtered.map((workflow) => {
              const progress = workflowProgress(workflow);
              return (
                <button
                  aria-selected={workflow.id === selectedId}
                  className={cn(
                    "flex min-w-0 cursor-pointer flex-col gap-2 rounded-lg px-3 py-2.5 text-left outline-none ring-ring transition-colors hover:bg-accent focus-visible:ring-2",
                    workflow.id === selectedId && "bg-accent text-accent-foreground",
                  )}
                  key={workflow.id}
                  onClick={() => onSelect(workflow.id)}
                  role="option"
                  type="button"
                >
                  <span className="flex w-full min-w-0 items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{workflow.name}</span>
                    <Badge size="sm" variant={STATUS_VARIANT[workflow.status]}>
                      {STATUS_LABEL[workflow.status]}
                    </Badge>
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {workflow.threadTitle}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>
                      {progress.completed}/{progress.total} steps
                    </span>
                    <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full bg-primary"
                        style={{ width: `${progress.percent}%` }}
                      />
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </section>
  );
}

function StepIcon({
  status,
}: {
  readonly status: EnvironmentThreadWorkflow["steps"][number]["status"];
}) {
  const Icon =
    status === "completed"
      ? CheckCircle2Icon
      : status === "failed"
        ? CircleXIcon
        : status === "running"
          ? PlayIcon
          : CircleDashedIcon;
  return (
    <Icon
      aria-hidden
      className={cn(
        "size-4",
        status === "completed" && "text-success-foreground",
        status === "failed" && "text-destructive-foreground",
        status === "running" && "text-info-foreground",
      )}
    />
  );
}

function WorkflowInspector({
  workflow,
  busy,
  onBack,
  onAction,
  onCancel,
}: {
  readonly workflow: EnvironmentThreadWorkflow;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onAction: (action: "pause" | "resume" | "retry" | "restart", fromStep?: number) => void;
  readonly onCancel: () => void;
}) {
  const progress = workflowProgress(workflow);
  const restartable = new Set(restartableWorkflowSteps(workflow));
  const allowRestart =
    workflow.status === "completed" ||
    workflow.status === "failed" ||
    workflow.status === "cancelled";
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-4 py-3 md:hidden">
        <Button aria-label="Back to workflows" onClick={onBack} size="icon-sm" variant="ghost">
          <ArrowLeftIcon />
        </Button>
        <span className="truncate text-sm font-medium">{workflow.name}</span>
      </div>
      <ScrollArea className="min-h-0 flex-1" radius="none" scrollbarGutter>
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-5 lg:p-7">
          <header className="flex flex-col gap-4 border-b border-border/70 pb-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-heading text-xl font-semibold">{workflow.name}</h2>
                <Badge variant={STATUS_VARIANT[workflow.status]}>
                  {STATUS_LABEL[workflow.status]}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {workflow.threadTitle} · {progress.completed}/{progress.total} steps complete
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Updated {formatDate(workflow.updatedAt)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
              {canPauseWorkflow(workflow) ? (
                <Button
                  disabled={busy}
                  onClick={() => onAction("pause")}
                  size="sm"
                  variant="outline"
                >
                  <PauseIcon /> Pause
                </Button>
              ) : null}
              {workflow.status === "paused" ? (
                <Button disabled={busy} onClick={() => onAction("resume")} size="sm">
                  <PlayIcon /> Resume
                </Button>
              ) : null}
              {workflow.status === "failed" ? (
                <Button disabled={busy} onClick={() => onAction("retry")} size="sm">
                  <RotateCcwIcon /> Retry step
                </Button>
              ) : null}
              {workflow.status === "running" ||
              workflow.status === "paused" ||
              workflow.status === "failed" ? (
                <Button
                  aria-label="Cancel workflow"
                  disabled={busy}
                  onClick={onCancel}
                  size="icon-sm"
                  variant="ghost"
                >
                  <Trash2Icon />
                </Button>
              ) : null}
            </div>
          </header>
          <ol className="m-0 flex list-none flex-col p-0" aria-label="Workflow steps">
            {workflow.steps.map((step, index) => (
              <li
                className="relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 pb-5 last:pb-0"
                key={step.index}
              >
                {index < workflow.steps.length - 1 ? (
                  <span aria-hidden className="absolute top-6 bottom-0 left-3 w-px bg-border" />
                ) : null}
                <span className="relative z-10 flex size-6 items-center justify-center rounded-full border border-border bg-background">
                  <StepIcon status={step.status} />
                </span>
                <article className="min-w-0 rounded-xl border border-border/70 bg-card px-4 py-3 shadow-xs/5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold">
                          {index + 1}. {step.title}
                        </h3>
                        <Badge
                          size="sm"
                          variant={
                            step.status === "failed"
                              ? "error"
                              : step.status === "completed"
                                ? "success"
                                : step.status === "running"
                                  ? "info"
                                  : "outline"
                          }
                        >
                          {step.status}
                        </Badge>
                        {step.attempt > 1 ? (
                          <Badge size="sm" variant="warning">
                            Attempt {step.attempt}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-5 text-secondary-label">
                        {step.prompt}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          {step.dependsOn.length === 0
                            ? "No dependencies"
                            : `Depends on ${step.dependsOn.map((dependency) => `step ${dependency + 1}`).join(", ")}`}
                        </span>
                        {step.branch ? <span className="font-mono">{step.branch}</span> : null}
                      </div>
                    </div>
                    {allowRestart && restartable.has(index + 1) ? (
                      <Button
                        aria-label={`Restart from step ${index + 1}`}
                        disabled={busy}
                        onClick={() => onAction("restart", index + 1)}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <RotateCcwIcon />
                      </Button>
                    ) : null}
                  </div>
                  {step.result ? (
                    <div
                      className={cn(
                        "mt-3 rounded-lg border px-3 py-2 text-sm",
                        step.status === "failed"
                          ? "border-destructive/30 bg-destructive/8 text-destructive-foreground"
                          : "border-border/70 bg-muted/20 text-secondary-label",
                      )}
                    >
                      <span className="font-medium text-foreground">Result: </span>
                      {step.result}
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>Started {formatDate(step.startedAt)}</span>
                    <span>Finished {formatDate(step.completedAt)}</span>
                  </div>
                </article>
              </li>
            ))}
          </ol>
        </div>
      </ScrollArea>
    </section>
  );
}

function ProjectWorkflows({
  project,
  threads,
}: {
  readonly project: EnvironmentProject;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const { workflows, error, isPending, refresh } = useWorkflows(project.environmentId, project.id);
  const pause = useAtomCommand(workflowEnvironment.pause, { reportFailure: false });
  const resume = useAtomCommand(workflowEnvironment.resume, { reportFailure: false });
  const retry = useAtomCommand(workflowEnvironment.retry, { reportFailure: false });
  const restart = useAtomCommand(workflowEnvironment.restart, { reportFailure: false });
  const cancel = useAtomCommand(workflowEnvironment.cancel, { reportFailure: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showInspector, setShowInspector] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<EnvironmentThreadWorkflow | null>(null);
  const selected = workflows.find((workflow) => workflow.id === selectedId) ?? workflows[0] ?? null;

  const act = async (
    workflow: EnvironmentThreadWorkflow,
    action: "pause" | "resume" | "retry" | "restart" | "cancel",
    fromStep?: number,
  ) => {
    setBusy(true);
    setActionError(null);
    const input = { projectId: project.id, workflowId: workflow.id };
    const target = { environmentId: project.environmentId, input };
    const result =
      action === "restart"
        ? fromStep === undefined
          ? null
          : await restart({
              environmentId: project.environmentId,
              input: { ...input, fromStep },
            })
        : action === "pause"
          ? await pause(target)
          : action === "resume"
            ? await resume(target)
            : action === "retry"
              ? await retry(target)
              : await cancel(target);
    setBusy(false);
    if (result === null) {
      setActionError("Choose a workflow step to restart from.");
      return;
    }
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setActionError(errorMessage(squashAtomCommandFailure(result)));
      return;
    }
    if (action === "cancel") setCancelTarget(null);
  };

  if (isPending && workflows.length === 0)
    return (
      <div className="flex flex-1 gap-4 p-4">
        <Skeleton className="w-80" shape="card" />
        <Skeleton className="flex-1" shape="card" />
      </div>
    );
  if (error && workflows.length === 0)
    return (
      <Empty size="hero">
        <EmptyHeader>
          <EmptyTitle>Workflows unavailable</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
        <Button onClick={refresh} variant="outline">
          Try again
        </Button>
      </Empty>
    );

  return (
    <>
      {actionError ? (
        <div className="absolute top-16 right-4 z-20 rounded-lg border border-destructive/30 bg-background px-3 py-2 text-sm text-destructive-foreground shadow-lg">
          {actionError}
        </div>
      ) : null}
      <div className={cn("min-h-0 min-w-0 flex-1", showInspector && "hidden md:flex")}>
        <WorkflowList
          workflows={workflows}
          selectedId={selected?.id ?? null}
          onSelect={(id) => {
            setSelectedId(id);
            setShowInspector(true);
          }}
          onCreate={() => setCreateOpen(true)}
          refresh={refresh}
        />
      </div>
      {selected ? (
        <div className={cn("min-h-0 min-w-0 flex-1", !showInspector && "hidden md:flex")}>
          <WorkflowInspector
            workflow={selected}
            busy={busy}
            onBack={() => setShowInspector(false)}
            onAction={(action, fromStep) => void act(selected, action, fromStep)}
            onCancel={() => setCancelTarget(selected)}
          />
        </div>
      ) : (
        <div className="hidden min-h-0 min-w-0 flex-1 md:flex">
          <Empty size="hero">
            <EmptyMedia variant="icon">
              <WorkflowIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>Select a workflow</EmptyTitle>
              <EmptyDescription>
                Choose a workflow to inspect its durable steps and results.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      )}
      <CreateWorkflowDialog
        key={`${project.id}:${createOpen ? "open" : "closed"}`}
        open={createOpen}
        onOpenChange={setCreateOpen}
        project={project}
        threads={threads}
      />
      <AlertDialog
        open={cancelTarget !== null}
        onOpenChange={(open) => !open && setCancelTarget(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this workflow?</AlertDialogTitle>
            <AlertDialogDescription>
              Completed step results remain readable, but pending steps will not run.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={busy} render={<Button variant="outline" />}>
              Keep workflow
            </AlertDialogClose>
            <Button
              disabled={busy || cancelTarget === null}
              onClick={() => cancelTarget && void act(cancelTarget, "cancel")}
              variant="destructive"
            >
              {busy ? "Cancelling…" : "Cancel workflow"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

export function WorkflowManagementPage() {
  const projects = useProjects();
  const allThreads = useThreadShells();
  const [requestedProjectKey, setRequestedProjectKey] = useState<string | null>(null);
  const selectedProject =
    projects.find((project) => environmentProjectKey(project) === requestedProjectKey) ??
    projects[0] ??
    null;
  const threads = selectedProject
    ? allThreads
        .filter(
          (thread) =>
            thread.environmentId === selectedProject.environmentId &&
            thread.projectId === selectedProject.id &&
            thread.archivedAt === null,
        )
        .toSorted((left, right) => left.title.localeCompare(right.title))
    : [];
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex w-full min-w-0 items-center py-2">
            <WorkspaceBreadcrumb ariaLabel="Workflow breadcrumb">
              <WorkspaceBreadcrumbItem>
                <h1>Workflows</h1>
              </WorkspaceBreadcrumbItem>
              {selectedProject ? (
                <>
                  <WorkspaceBreadcrumbSeparator />
                  <WorkspaceBreadcrumbItem current className="min-w-0">
                    <ProjectPicker
                      projects={projects}
                      value={environmentProjectKey(selectedProject)}
                      onChange={setRequestedProjectKey}
                    />
                  </WorkspaceBreadcrumbItem>
                </>
              ) : null}
            </WorkspaceBreadcrumb>
          </div>
        </WorkspacePageHeader>
        <main className="relative flex min-h-0 min-w-0 flex-1">
          {selectedProject ? (
            <ProjectWorkflows
              key={environmentProjectKey(selectedProject)}
              project={selectedProject}
              threads={threads}
            />
          ) : (
            <Empty size="hero">
              <EmptyMedia variant="icon">
                <WorkflowIcon />
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>No projects available</EmptyTitle>
                <EmptyDescription>
                  Connect an environment and add a project before creating workflows.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </main>
      </div>
    </SidebarInset>
  );
}
