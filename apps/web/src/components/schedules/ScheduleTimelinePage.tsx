import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadSchedule } from "@t3tools/contracts";
import {
  CalendarClockIcon,
  CheckCircle2Icon,
  CirclePauseIcon,
  Clock3Icon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  Repeat2Icon,
  Trash2Icon,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { isElectron } from "../../env";
import { useEnvironments } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { scheduleEnvironment, useSchedules } from "../../state/schedules";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import {
  formatInterval,
  groupSchedules,
  resolveScheduleDraft,
  type ScheduleDraft,
  type ScheduleGroupKey,
} from "./ScheduleTimelinePage.logic";
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

const GROUPS: ReadonlyArray<{
  readonly key: ScheduleGroupKey;
  readonly title: string;
  readonly description: string;
  readonly icon: typeof Clock3Icon;
}> = [
  {
    key: "upcoming",
    title: "Upcoming",
    description: "One-time tasks, ordered by their next run.",
    icon: Clock3Icon,
  },
  {
    key: "recurring",
    title: "Recurring",
    description: "Tasks that continue on a fixed interval.",
    icon: Repeat2Icon,
  },
  {
    key: "paused",
    title: "Paused",
    description: "Tasks held until you resume them.",
    icon: CirclePauseIcon,
  },
  {
    key: "completed",
    title: "Completed",
    description: "One-time tasks that have already run.",
    icon: CheckCircle2Icon,
  },
];

function environmentProjectKey(project: EnvironmentProject): string {
  return scopedProjectKey({ environmentId: project.environmentId, projectId: project.id });
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function formatRelative(value: string, nowMs = Date.now()): string {
  const target = Date.parse(value);
  if (!Number.isFinite(target)) return "Unknown time";
  const minutes = Math.round((target - nowMs) / 60_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function defaultLocalRunTime(): string {
  const date = new Date(Date.now() + 60 * 60_000);
  const local = new Date(date.valueOf() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The schedule operation failed.";
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
  const environmentLabels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const selected = projects.find((project) => environmentProjectKey(project) === value);

  return (
    <Select value={value} onValueChange={(next) => next && onChange(next)}>
      <SelectTrigger
        aria-label="Schedule project"
        size="compact"
        variant="ghost"
        className="w-auto min-w-0"
      >
        <SelectValue>
          {selected
            ? `${selected.title} · ${environmentLabels.get(selected.environmentId) ?? "Environment"}`
            : "Choose project"}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        {projects.map((project) => {
          const key = environmentProjectKey(project);
          return (
            <SelectItem key={key} value={key}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{project.title}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {environmentLabels.get(project.environmentId) ?? "Environment"}
                </span>
              </span>
            </SelectItem>
          );
        })}
      </SelectPopup>
    </Select>
  );
}

function CreateScheduleDialog({
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
  const createSchedule = useAtomCommand(scheduleEnvironment.create, { reportFailure: false });
  const [threadId, setThreadId] = useState(threads[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [draft, setDraft] = useState<ScheduleDraft>({
    mode: "once",
    atLocal: defaultLocalRunTime(),
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedPrompt = prompt.trim();
    if (!threadId) {
      setError("Choose a thread for this task.");
      return;
    }
    if (!trimmedPrompt) {
      setError("Describe what the agent should do.");
      return;
    }
    const resolved = resolveScheduleDraft(draft);
    if (resolved.value === null) {
      setError(resolved.error);
      return;
    }

    setSubmitting(true);
    setError(null);
    const result = await createSchedule({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        threadId: threadId as EnvironmentThreadShell["id"],
        prompt: trimmedPrompt,
        ...resolved.value,
      },
    });
    setSubmitting(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(errorMessage(squashAtomCommandFailure(result)));
      }
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Schedule an agent task</DialogTitle>
            <DialogDescription>
              The selected thread will start a new agent turn when this task is due.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Thread
              <Select value={threadId} onValueChange={(value) => value && setThreadId(value)}>
                <SelectTrigger aria-label="Scheduled task thread">
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
              Task
              <Textarea
                aria-invalid={error !== null && prompt.trim().length === 0}
                maxLength={20_000}
                onChange={(event) => setPrompt(event.currentTarget.value)}
                placeholder="Check the deployment and report only actionable failures."
                value={prompt}
              />
              <span className="text-xs font-normal text-muted-foreground">
                Write a complete instruction that can run without this conversation in view.
              </span>
            </label>

            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Schedule
              <Select
                value={draft.mode}
                onValueChange={(value) => {
                  if (value === "once") {
                    setDraft({ mode: "once", atLocal: defaultLocalRunTime() });
                  } else if (value === "interval") {
                    setDraft({ mode: "interval", everyAmount: "1", everyUnit: "hours" });
                  }
                  setError(null);
                }}
              >
                <SelectTrigger aria-label="Schedule type">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="once">Run once</SelectItem>
                  <SelectItem value="interval">Repeat on an interval</SelectItem>
                </SelectPopup>
              </Select>
            </label>

            {draft.mode === "once" ? (
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Run at
                <Input
                  nativeInput
                  type="datetime-local"
                  value={draft.atLocal}
                  onChange={(event) =>
                    setDraft({ mode: "once", atLocal: event.currentTarget.value })
                  }
                />
              </label>
            ) : (
              <div className="flex flex-col gap-1.5 text-sm font-medium">
                Repeat every
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(8rem,auto)] gap-2">
                  <Input
                    nativeInput
                    inputMode="numeric"
                    min={1}
                    step={1}
                    type="number"
                    value={draft.everyAmount}
                    onChange={(event) =>
                      setDraft({ ...draft, everyAmount: event.currentTarget.value })
                    }
                  />
                  <Select
                    value={draft.everyUnit}
                    onValueChange={(value) => {
                      if (value === "minutes" || value === "hours" || value === "days") {
                        setDraft({ ...draft, everyUnit: value });
                      }
                    }}
                  >
                    <SelectTrigger aria-label="Repeat unit">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="minutes">Minutes</SelectItem>
                      <SelectItem value="hours">Hours</SelectItem>
                      <SelectItem value="days">Days</SelectItem>
                    </SelectPopup>
                  </Select>
                </div>
              </div>
            )}

            {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose disabled={submitting} render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button disabled={submitting || threads.length === 0} type="submit">
              {submitting ? "Scheduling…" : "Schedule task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function ScheduleRow({
  schedule,
  busy,
  onPause,
  onResume,
  onDelete,
}: {
  readonly schedule: EnvironmentThreadSchedule;
  readonly busy: boolean;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onDelete: () => void;
}) {
  const active = schedule.status === "active";
  const primaryTime =
    schedule.status === "completed" && schedule.lastRunAt ? schedule.lastRunAt : schedule.nextRunAt;

  return (
    <li className="relative grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-3 pb-5 last:pb-0 sm:grid-cols-[8.5rem_1rem_minmax(0,1fr)] sm:gap-x-4">
      <time
        className="col-start-2 mb-1 text-xs font-medium tabular-nums text-muted-foreground sm:col-start-1 sm:mb-0 sm:pt-3 sm:text-right"
        dateTime={primaryTime}
      >
        {formatDate(primaryTime)}
      </time>
      <div className="relative col-start-1 row-start-1 row-end-3 sm:col-start-2 sm:row-end-2">
        <span
          aria-hidden
          className="absolute top-0 bottom-[-1.25rem] left-1/2 w-px -translate-x-1/2 bg-border last:hidden"
        />
        <span
          aria-hidden
          className={cn(
            "absolute top-3 left-1/2 size-2.5 -translate-x-1/2 rounded-full border-2 border-background bg-muted-foreground ring-1 ring-border",
            active && "bg-primary ring-primary/50",
          )}
        />
      </div>
      <article className="col-start-2 min-w-0 rounded-xl border border-border/70 bg-card px-4 py-3 shadow-xs/5 sm:col-start-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-semibold">{schedule.threadTitle}</h3>
              <Badge size="sm" variant={schedule.status === "paused" ? "outline" : "secondary"}>
                {schedule.status === "paused"
                  ? "Paused"
                  : schedule.status === "completed"
                    ? "Completed"
                    : schedule.scheduleKind === "interval"
                      ? formatInterval(schedule.intervalSeconds)
                      : "Once"}
              </Badge>
            </div>
            <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm leading-5 text-secondary-label">
              {schedule.prompt}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {schedule.status === "paused" ? (
              <Button
                aria-label={`Resume ${schedule.threadTitle}`}
                disabled={busy}
                onClick={onResume}
                size="icon-sm"
                variant="ghost"
              >
                <PlayIcon />
              </Button>
            ) : schedule.status === "active" ? (
              <Button
                aria-label={`Pause ${schedule.threadTitle}`}
                disabled={busy}
                onClick={onPause}
                size="icon-sm"
                variant="ghost"
              >
                <PauseIcon />
              </Button>
            ) : null}
            <Button
              aria-label={`Delete ${schedule.threadTitle}`}
              disabled={busy}
              onClick={onDelete}
              size="icon-sm"
              variant="ghost"
            >
              <Trash2Icon />
            </Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-border/60 pt-2 text-xs text-muted-foreground">
          {schedule.status === "active" ? (
            <span>Next run {formatRelative(schedule.nextRunAt)}</span>
          ) : null}
          {schedule.lastRunAt ? <span>Last ran {formatRelative(schedule.lastRunAt)}</span> : null}
          <span className="font-mono">{schedule.id.slice(0, 8)}</span>
        </div>
      </article>
    </li>
  );
}

function ScheduleTimeline({
  project,
  threads,
}: {
  readonly project: EnvironmentProject;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const { schedules, error, isPending, refresh } = useSchedules(project.environmentId, project.id);
  const pauseSchedule = useAtomCommand(scheduleEnvironment.pause, { reportFailure: false });
  const resumeSchedule = useAtomCommand(scheduleEnvironment.resume, { reportFailure: false });
  const removeSchedule = useAtomCommand(scheduleEnvironment.remove, { reportFailure: false });
  const [createOpen, setCreateOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EnvironmentThreadSchedule | null>(null);
  const groups = useMemo(() => groupSchedules(schedules), [schedules]);

  const mutate = async (
    schedule: EnvironmentThreadSchedule,
    action: "pause" | "resume" | "remove",
  ) => {
    setBusyId(schedule.id);
    setActionError(null);
    const command =
      action === "pause" ? pauseSchedule : action === "resume" ? resumeSchedule : removeSchedule;
    const result = await command({
      environmentId: project.environmentId,
      input: { projectId: project.id, scheduleId: schedule.id },
    });
    setBusyId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setActionError(errorMessage(squashAtomCommandFailure(result)));
      return;
    }
    if (action === "remove") setDeleteTarget(null);
  };

  if (isPending && schedules.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="grid grid-cols-[8.5rem_1rem_minmax(0,1fr)] gap-4" key={index}>
            <Skeleton className="mt-3 h-3 w-24 justify-self-end" />
            <Skeleton className="mt-3 size-3" shape="pill" />
            <Skeleton className="h-28 w-full" shape="card" />
          </div>
        ))}
      </div>
    );
  }

  if (error && schedules.length === 0) {
    return (
      <Empty size="hero">
        <EmptyHeader>
          <EmptyTitle>Schedules unavailable</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
        <Button onClick={refresh} variant="outline">
          Try again
        </Button>
      </Empty>
    );
  }

  return (
    <>
      <ScrollArea className="min-h-0 flex-1" radius="none" scrollbarGutter>
        <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-5 sm:px-6 sm:py-7">
          <div className="mb-6 flex flex-col gap-4 border-b border-border/70 pb-5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="font-heading text-xl font-semibold">Agent schedules</h2>
              <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                Tasks run on the selected thread even when every client is closed.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
              <Button
                aria-label="Refresh schedules"
                onClick={refresh}
                size="icon-sm"
                variant="ghost"
              >
                <RefreshCwIcon />
              </Button>
              <Button disabled={threads.length === 0} onClick={() => setCreateOpen(true)} size="sm">
                <PlusIcon />
                New schedule
              </Button>
            </div>
          </div>

          {actionError ? (
            <div className="mb-5 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground">
              {actionError}
            </div>
          ) : null}

          {schedules.length === 0 ? (
            <div className="flex min-h-96 rounded-xl border border-dashed border-border/80">
              <Empty size="compact">
                <EmptyMedia variant="icon">
                  <CalendarClockIcon />
                </EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>No scheduled tasks</EmptyTitle>
                  <EmptyDescription>
                    Schedule an agent to check something once or keep watch on an interval.
                  </EmptyDescription>
                </EmptyHeader>
                <Button disabled={threads.length === 0} onClick={() => setCreateOpen(true)}>
                  <PlusIcon />
                  Schedule a task
                </Button>
              </Empty>
            </div>
          ) : (
            <div className="flex flex-col gap-8">
              {GROUPS.map((group) => {
                const items = groups[group.key];
                if (items.length === 0) return null;
                const Icon = group.icon;
                return (
                  <section aria-labelledby={`schedule-group-${group.key}`} key={group.key}>
                    <div className="mb-4 flex items-start gap-2">
                      <Icon aria-hidden className="mt-0.5 size-4 text-muted-foreground" />
                      <div>
                        <h2 className="text-sm font-semibold" id={`schedule-group-${group.key}`}>
                          {group.title}{" "}
                          <span className="font-normal text-muted-foreground">{items.length}</span>
                        </h2>
                        <p className="text-xs text-muted-foreground">{group.description}</p>
                      </div>
                    </div>
                    <ol className="m-0 list-none p-0">
                      {items.map((schedule) => (
                        <ScheduleRow
                          busy={busyId === schedule.id}
                          key={schedule.id}
                          onDelete={() => setDeleteTarget(schedule)}
                          onPause={() => void mutate(schedule, "pause")}
                          onResume={() => void mutate(schedule, "resume")}
                          schedule={schedule}
                        />
                      ))}
                    </ol>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </ScrollArea>

      <CreateScheduleDialog
        key={`${project.environmentId}:${project.id}:${createOpen ? "open" : "closed"}`}
        onOpenChange={setCreateOpen}
        open={createOpen}
        project={project}
        threads={threads}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `The task for “${deleteTarget.threadTitle}” will stop running. This cannot be undone.`
                : "This scheduled task will stop running."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={busyId !== null} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              disabled={deleteTarget === null || busyId !== null}
              onClick={() => deleteTarget && void mutate(deleteTarget, "remove")}
              variant="destructive"
            >
              {busyId ? "Deleting…" : "Delete schedule"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

export function ScheduleTimelinePage() {
  const projects = useProjects();
  const allThreads = useThreadShells();
  const [requestedProjectKey, setRequestedProjectKey] = useState<string | null>(null);
  const selectedProject =
    projects.find((project) => environmentProjectKey(project) === requestedProjectKey) ??
    projects[0] ??
    null;
  const projectThreads = selectedProject
    ? allThreads
        .filter(
          (thread) =>
            thread.environmentId === selectedProject.environmentId &&
            thread.projectId === selectedProject.id &&
            thread.archivedAt === null,
        )
        .sort((left, right) => left.title.localeCompare(right.title))
    : [];

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex w-full min-w-0 items-center py-2">
            <WorkspaceBreadcrumb ariaLabel="Schedule breadcrumb">
              <WorkspaceBreadcrumbItem>
                <h1>Schedules</h1>
              </WorkspaceBreadcrumbItem>
              {selectedProject ? (
                <>
                  <WorkspaceBreadcrumbSeparator />
                  <WorkspaceBreadcrumbItem current className="min-w-0">
                    <ProjectPicker
                      onChange={setRequestedProjectKey}
                      projects={projects}
                      value={environmentProjectKey(selectedProject)}
                    />
                  </WorkspaceBreadcrumbItem>
                </>
              ) : null}
            </WorkspaceBreadcrumb>
          </div>
        </WorkspacePageHeader>
        <main className="flex min-h-0 min-w-0 flex-1">
          {selectedProject ? (
            <ScheduleTimeline
              key={environmentProjectKey(selectedProject)}
              project={selectedProject}
              threads={projectThreads}
            />
          ) : (
            <Empty size="hero">
              <EmptyMedia variant="icon">
                <CalendarClockIcon />
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>No projects available</EmptyTitle>
                <EmptyDescription>
                  Connect an environment and add a project before scheduling an agent task.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </main>
      </div>
    </SidebarInset>
  );
}
