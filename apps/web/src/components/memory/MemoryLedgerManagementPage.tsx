import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentAgentMemory, EnvironmentThreadLedgerSnapshot } from "@t3tools/contracts";
import {
  BookOpenIcon,
  BrainIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { useEnvironments } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { memoryLedgerEnvironment, useLedger, useMemories } from "../../state/memoryLedger";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

function projectKey(project: EnvironmentProject): string {
  return scopedProjectKey({ environmentId: project.environmentId, projectId: project.id });
}

function failureMessage(result: unknown): string {
  const error = squashAtomCommandFailure(result as never);
  return error instanceof Error && error.message.trim() ? error.message : "The operation failed.";
}

function ProjectPicker({
  projects,
  value,
  onChange,
}: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const environments = useEnvironments().environments;
  const labels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const selected = projects.find((project) => projectKey(project) === value);
  return (
    <Select value={value} onValueChange={(next) => next && onChange(next)}>
      <SelectTrigger
        aria-label="Memory project"
        size="compact"
        variant="ghost"
        className="w-auto min-w-0"
      >
        <SelectValue>
          {selected ? (
            <span className="flex min-w-0">
              <span className="truncate">{selected.title}</span>
              <span className="hidden sm:inline">
                {` · ${labels.get(selected.environmentId) ?? "Environment"}`}
              </span>
            </span>
          ) : (
            "Choose project"
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        {projects.map((project) => (
          <SelectItem key={projectKey(project)} value={projectKey(project)}>
            {project.title}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function MemoryForm({
  project,
  threads,
  memory,
  onDone,
}: {
  readonly project: EnvironmentProject;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly memory?: EnvironmentAgentMemory;
  readonly onDone: () => void;
}) {
  const create = useAtomCommand(memoryLedgerEnvironment.createMemory, { reportFailure: false });
  const update = useAtomCommand(memoryLedgerEnvironment.updateMemory, { reportFailure: false });
  const [kind, setKind] = useState<"lesson" | "memory">(memory?.kind ?? "memory");
  const [scope, setScope] = useState<"global" | "project">(memory?.scope ?? "project");
  const [sourceThreadId, setSourceThreadId] = useState(
    threads[0]?.id ?? memory?.sourceThreadId ?? "",
  );
  const [content, setContent] = useState(memory?.content ?? "");
  const [negative, setNegative] = useState(memory?.negative ?? "");
  const [tags, setTags] = useState(memory?.tags.join(", ") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const normalizedTags = [
      ...new Set(
        tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ];
    if (!content.trim() || (!memory && !sourceThreadId)) {
      setError("Content and a source thread are required.");
      return;
    }
    setSaving(true);
    const result = memory
      ? await update({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            memoryId: memory.id,
            content: content.trim(),
            negative: negative.trim() || null,
            tags: normalizedTags,
          },
        })
      : await create({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            sourceThreadId: sourceThreadId as EnvironmentThreadShell["id"],
            kind,
            scope,
            content: content.trim(),
            negative: negative.trim() || null,
            tags: normalizedTags,
          },
        });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setError(failureMessage(result));
      return;
    }
    onDone();
  };

  return (
    <div className="grid gap-3 rounded-xl border border-border/70 bg-card p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="grid gap-1.5 text-sm font-medium">
          Kind
          <Select
            value={kind}
            onValueChange={(value) => value && setKind(value as typeof kind)}
            disabled={Boolean(memory)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="memory">Memory</SelectItem>
              <SelectItem value="lesson">Lesson</SelectItem>
            </SelectPopup>
          </Select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Scope
          <Select
            value={scope}
            onValueChange={(value) => value && setScope(value as typeof scope)}
            disabled={Boolean(memory)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="project">This project</SelectItem>
              <SelectItem value="global">All projects</SelectItem>
            </SelectPopup>
          </Select>
        </label>
        {!memory ? (
          <label className="grid gap-1.5 text-sm font-medium">
            Source thread
            <Select
              value={sourceThreadId}
              onValueChange={(value) => value && setSourceThreadId(value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose thread" />
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
        ) : null}
      </div>
      <label className="grid gap-1.5 text-sm font-medium">
        Content
        <Textarea
          maxLength={2_000}
          value={content}
          onChange={(event) => setContent(event.currentTarget.value)}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-medium">
        Avoid / negative guidance
        <Textarea
          maxLength={1_000}
          value={negative}
          onChange={(event) => setNegative(event.currentTarget.value)}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-medium">
        Tags
        <Input
          nativeInput
          placeholder="workflow, review"
          value={tags}
          onChange={(event) => setTags(event.currentTarget.value)}
        />
      </label>
      {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button disabled={saving} onClick={() => void save()}>
          <SaveIcon />
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function MemoriesPanel({
  project,
  threads,
}: {
  readonly project: EnvironmentProject;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const { memories, error, isPending, refresh } = useMemories(project.environmentId, project.id);
  const remove = useAtomCommand(memoryLedgerEnvironment.removeMemory, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<EnvironmentAgentMemory | "new" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? memories.filter((memory) =>
          [memory.content, memory.negative ?? "", ...memory.tags]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        )
      : memories;
  }, [memories, query]);

  const removeMemory = async (memory: EnvironmentAgentMemory) => {
    if (!window.confirm("Permanently delete this memory?")) return;
    const result = await remove({
      environmentId: project.environmentId,
      input: { projectId: project.id, memoryId: memory.id },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      setActionError(failureMessage(result));
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          nativeInput
          aria-label="Search memories"
          className="min-w-48 flex-1"
          placeholder="Search memories and lessons"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <Button aria-label="Refresh memories" size="icon-sm" variant="ghost" onClick={refresh}>
          <RefreshCwIcon />
        </Button>
        <Button onClick={() => setEditing("new")}>
          <PlusIcon />
          Add memory
        </Button>
      </div>
      {editing ? (
        <MemoryForm
          project={project}
          threads={threads}
          {...(editing === "new" ? {} : { memory: editing })}
          onDone={() => setEditing(null)}
        />
      ) : null}
      {error || actionError ? (
        <p className="text-sm text-destructive-foreground">{actionError ?? error}</p>
      ) : null}
      {!isPending && filtered.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No memories found</EmptyTitle>
            <EmptyDescription>
              Save reusable facts or behavioral lessons for future threads.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      <div className="grid gap-3">
        {filtered.map((memory) => (
          <article key={memory.id} className="rounded-xl border border-border/70 bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">{memory.kind}</Badge>
                <Badge variant="outline">{memory.scope}</Badge>
                {memory.tags.map((tag) => (
                  <Badge key={tag} variant="outline">
                    {tag}
                  </Badge>
                ))}
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setEditing(memory)}>
                  Edit
                </Button>
                <Button
                  aria-label="Delete memory"
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => void removeMemory(memory)}
                >
                  <Trash2Icon />
                </Button>
              </div>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm">{memory.content}</p>
            {memory.negative ? (
              <p className="mt-2 text-sm text-muted-foreground">
                <strong>Avoid:</strong> {memory.negative}
              </p>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}

function LedgerEditor({
  project,
  thread,
}: {
  readonly project: EnvironmentProject;
  readonly thread: EnvironmentThreadShell;
}) {
  const { snapshot, error, isPending } = useLedger(project.environmentId, project.id, thread.id);
  if (isPending && !snapshot)
    return <p className="p-6 text-sm text-muted-foreground">Loading ledger…</p>;
  return (
    <LedgerEditorForm
      key={snapshot?.state?.updatedAt ?? "empty"}
      project={project}
      thread={thread}
      snapshot={snapshot}
      error={error}
    />
  );
}

function LedgerEditorForm({
  project,
  thread,
  snapshot,
  error,
}: {
  readonly project: EnvironmentProject;
  readonly thread: EnvironmentThreadShell;
  readonly snapshot: EnvironmentThreadLedgerSnapshot | null;
  readonly error: string | null;
}) {
  const update = useAtomCommand(memoryLedgerEnvironment.updateLedger, { reportFailure: false });
  const clear = useAtomCommand(memoryLedgerEnvironment.clearLedger, { reportFailure: false });
  const state = snapshot?.state;
  const [goal, setGoal] = useState(state?.goal ?? "");
  const [phase, setPhase] = useState(state?.phase ?? "");
  const [next, setNext] = useState(state?.next ?? "");
  const [artifacts, setArtifacts] = useState(JSON.stringify(state?.artifacts ?? {}, null, 2));
  const [eventKind, setEventKind] = useState("");
  const [event, setEvent] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(artifacts);
    } catch {
      setActionError("Artifacts must be a JSON object.");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setActionError("Artifacts must be a JSON object.");
      return;
    }
    const result = await update({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        threadId: thread.id,
        goal: goal.trim() || null,
        phase: phase.trim() || null,
        next: next.trim() || null,
        artifacts: parsed as Record<string, string>,
        ...(eventKind.trim() && event.trim()
          ? { eventKind: eventKind.trim(), event: event.trim() }
          : {}),
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      setActionError(failureMessage(result));
  };
  const clearLedger = async () => {
    if (!window.confirm("Clear this thread ledger and its event history?")) return;
    const result = await clear({
      environmentId: project.environmentId,
      input: { projectId: project.id, threadId: thread.id },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      setActionError(failureMessage(result));
  };

  return (
    <div className="grid gap-5 p-4 sm:p-6">
      <div>
        <h2 className="font-heading text-xl font-semibold">{thread.title}</h2>
        <p className="text-sm text-muted-foreground">Durable resume state and progress events.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-sm font-medium sm:col-span-2">
          Goal
          <Textarea value={goal} onChange={(e) => setGoal(e.currentTarget.value)} />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Phase
          <Input nativeInput value={phase} onChange={(e) => setPhase(e.currentTarget.value)} />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Next action
          <Input nativeInput value={next} onChange={(e) => setNext(e.currentTarget.value)} />
        </label>
        <label className="grid gap-1.5 text-sm font-medium sm:col-span-2">
          Artifacts JSON
          <Textarea value={artifacts} onChange={(e) => setArtifacts(e.currentTarget.value)} />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Event kind
          <Input
            nativeInput
            placeholder="progress"
            value={eventKind}
            onChange={(e) => setEventKind(e.currentTarget.value)}
          />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Event
          <Input
            nativeInput
            placeholder="Implemented the next step"
            value={event}
            onChange={(e) => setEvent(e.currentTarget.value)}
          />
        </label>
      </div>
      {error || actionError ? (
        <p className="text-sm text-destructive-foreground">{actionError ?? error}</p>
      ) : null}
      <div className="flex justify-between">
        <Button variant="ghost" onClick={() => void clearLedger()}>
          <Trash2Icon />
          Clear ledger
        </Button>
        <Button onClick={() => void save()}>
          <SaveIcon />
          Save ledger
        </Button>
      </div>
      <div>
        <h3 className="mb-2 font-semibold">Event history</h3>
        <ol className="grid gap-2">
          {snapshot?.events.map((item) => (
            <li key={item.id} className="rounded-lg border border-border/70 p-3 text-sm">
              <span className="font-medium">{item.kind}</span>
              <span className="ml-2 text-muted-foreground">{item.createdAt}</span>
              <p className="mt-1 whitespace-pre-wrap">{item.message}</p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function LedgersPanel({
  project,
  threads,
}: {
  readonly project: EnvironmentProject;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const [threadId, setThreadId] = useState(threads[0]?.id ?? "");
  const selected = threads.find((thread) => thread.id === threadId) ?? threads[0];
  if (!selected)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No threads</EmptyTitle>
          <EmptyDescription>Create a thread before using a ledger.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return (
    <div className="grid min-h-0 flex-1 md:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="min-h-0 border-r border-border/70">
        <ScrollArea className="h-full">
          <div className="grid gap-1 p-2">
            {threads.map((thread) => (
              <Button
                key={thread.id}
                variant={thread.id === selected.id ? "secondary" : "ghost"}
                className="justify-start"
                onClick={() => setThreadId(thread.id)}
              >
                {thread.title}
              </Button>
            ))}
          </div>
        </ScrollArea>
      </div>
      <ScrollArea>
        <LedgerEditor key={selected.id} project={project} thread={selected} />
      </ScrollArea>
    </div>
  );
}

export function MemoryLedgerManagementPage() {
  const projects = useProjects();
  const threads = useThreadShells();
  const [selectedKey, setSelectedKey] = useState(() =>
    projects[0] ? projectKey(projects[0]) : "",
  );
  const [mode, setMode] = useState<"memories" | "ledgers">("memories");
  const project =
    projects.find((candidate) => projectKey(candidate) === selectedKey) ?? projects[0];
  const projectThreads = project
    ? threads.filter(
        (thread) =>
          thread.environmentId === project.environmentId &&
          thread.projectId === project.id &&
          thread.archivedAt === null,
      )
    : [];
  return (
    <SidebarInset className="min-h-0">
      <WorkspacePageHeader className="h-auto flex-col items-stretch py-2 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <WorkspaceBreadcrumb ariaLabel="Memory and ledger navigation">
            <WorkspaceBreadcrumbItem>
              <BrainIcon />
              <h1>Memory & Ledgers</h1>
            </WorkspaceBreadcrumbItem>
            {project ? (
              <>
                <WorkspaceBreadcrumbSeparator />
                <WorkspaceBreadcrumbItem>
                  <ProjectPicker
                    projects={projects}
                    value={projectKey(project)}
                    onChange={setSelectedKey}
                  />
                </WorkspaceBreadcrumbItem>
              </>
            ) : null}
          </WorkspaceBreadcrumb>
        </div>
        <div className="flex justify-end gap-1">
          <Button
            variant={mode === "memories" ? "secondary" : "ghost"}
            onClick={() => setMode("memories")}
          >
            <BrainIcon />
            Memories
          </Button>
          <Button
            variant={mode === "ledgers" ? "secondary" : "ghost"}
            onClick={() => setMode("ledgers")}
          >
            <BookOpenIcon />
            Ledgers
          </Button>
        </div>
      </WorkspacePageHeader>
      {project ? (
        mode === "memories" ? (
          <ScrollArea className="min-h-0 flex-1">
            <MemoriesPanel project={project} threads={projectThreads} />
          </ScrollArea>
        ) : (
          <LedgersPanel project={project} threads={projectThreads} />
        )
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No projects</EmptyTitle>
            <EmptyDescription>Connect an environment and add a project first.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </SidebarInset>
  );
}
