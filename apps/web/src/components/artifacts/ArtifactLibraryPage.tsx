import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentArtifactDetail,
  EnvironmentArtifactKind,
  EnvironmentArtifactSummary,
  EnvironmentArtifactVersion,
} from "@t3tools/contracts";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import {
  ArrowLeftIcon,
  BracesIcon,
  CodeXmlIcon,
  FileCodeIcon,
  FileTextIcon,
  LibraryBigIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useArtifact, useArtifacts } from "../../state/artifacts";
import { filterArtifacts, type ArtifactKindFilter } from "./ArtifactLibraryPage.logic";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";

const ARTIFACT_KINDS = ["all", "text", "markdown", "json", "html", "svg"] as const;

const KIND_LABEL: Record<EnvironmentArtifactKind, string> = {
  text: "Text",
  markdown: "Markdown",
  json: "JSON",
  html: "HTML",
  svg: "SVG",
};

function ArtifactKindIcon({ kind }: { readonly kind: EnvironmentArtifactKind }) {
  const Icon =
    kind === "json"
      ? BracesIcon
      : kind === "html" || kind === "svg"
        ? CodeXmlIcon
        : kind === "markdown"
          ? FileTextIcon
          : FileCodeIcon;
  return <Icon aria-hidden className="size-4" />;
}

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
        aria-label="Artifact project"
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

function LibrarySkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3" aria-label="Loading artifacts">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex items-center gap-3 rounded-lg p-3">
          <Skeleton className="size-8 shrink-0" shape="card" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ArtifactList({
  project,
  selectedSlug,
  onSelect,
}: {
  readonly project: EnvironmentProject;
  readonly selectedSlug: string | null;
  readonly onSelect: (slug: string) => void;
}) {
  const { artifacts, error, isPending, refresh } = useArtifacts(project.environmentId, project.id);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ArtifactKindFilter>("all");
  const filtered = useMemo(() => filterArtifacts(artifacts, query, kind), [artifacts, kind, query]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/16 md:max-w-80 md:border-r md:border-border/70 lg:max-w-96">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border/70 p-3">
        <div className="flex items-center gap-2">
          <Input
            aria-label="Search artifacts"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search artifacts"
            size="compact"
            type="search"
            value={query}
          />
          <Button aria-label="Refresh artifacts" onClick={refresh} size="icon-sm" variant="ghost">
            <RefreshCwIcon />
          </Button>
        </div>
        <Select
          value={kind}
          onValueChange={(value) => value && setKind(value as ArtifactKindFilter)}
        >
          <SelectTrigger aria-label="Filter artifact type" size="compact">
            <SelectValue>{kind === "all" ? "All types" : KIND_LABEL[kind]}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {ARTIFACT_KINDS.map((value) => (
              <SelectItem key={value} value={value}>
                {value === "all" ? "All types" : KIND_LABEL[value]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      <ScrollArea className="min-h-0 flex-1" radius="none">
        {isPending && artifacts.length === 0 ? (
          <LibrarySkeleton />
        ) : error ? (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyTitle>Artifacts unavailable</EmptyTitle>
              <EmptyDescription>{error}</EmptyDescription>
            </EmptyHeader>
            <Button onClick={refresh} size="sm" variant="outline">
              Try again
            </Button>
          </Empty>
        ) : filtered.length === 0 ? (
          <Empty size="compact">
            <EmptyMedia variant="icon">
              <LibraryBigIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>{artifacts.length === 0 ? "No artifacts yet" : "No matches"}</EmptyTitle>
              <EmptyDescription>
                {artifacts.length === 0
                  ? "Artifacts saved by agents for this project will appear here."
                  : "Try another search or artifact type."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-1 p-2" role="listbox" aria-label="Artifacts">
            {filtered.map((artifact) => (
              <button
                aria-selected={artifact.slug === selectedSlug}
                className={cn(
                  "flex min-w-0 cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 text-left outline-none ring-ring transition-colors hover:bg-accent focus-visible:ring-2",
                  artifact.slug === selectedSlug && "bg-accent text-accent-foreground",
                )}
                key={artifact.slug}
                onClick={() => onSelect(artifact.slug)}
                role="option"
                type="button"
              >
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background text-muted-foreground">
                  <ArtifactKindIcon kind={artifact.kind} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-sm font-medium">{artifact.name}</span>
                  <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                    <span>{KIND_LABEL[artifact.kind]}</span>
                    <span aria-hidden>·</span>
                    <span>v{artifact.currentVersion}</span>
                    <span aria-hidden>·</span>
                    <span className="truncate">{formatDate(artifact.updatedAt)}</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </section>
  );
}

function ContentPreview({ artifact }: { readonly artifact: EnvironmentArtifactDetail }) {
  return (
    <div className="min-h-48 overflow-auto rounded-lg border border-border/70 bg-muted/20 p-4">
      <pre className="m-0 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground">
        {artifact.content}
      </pre>
    </div>
  );
}

function VersionTimeline({
  versions,
  currentVersion,
  selectedVersion,
  onSelect,
}: {
  readonly versions: ReadonlyArray<EnvironmentArtifactVersion>;
  readonly currentVersion: number;
  readonly selectedVersion: number | undefined;
  readonly onSelect: (version: number | undefined) => void;
}) {
  return (
    <section aria-labelledby="artifact-versions-heading" className="flex min-w-0 flex-col gap-3">
      <h2 className="text-sm font-semibold" id="artifact-versions-heading">
        Versions
      </h2>
      <ol className="m-0 flex list-none flex-col p-0">
        {versions.map((version, index) => {
          const selected = (selectedVersion ?? currentVersion) === version.version;
          const isCurrent = version.version === currentVersion;
          return (
            <li className="relative flex min-w-0 gap-3 pb-4 last:pb-0" key={version.version}>
              {index < versions.length - 1 ? (
                <span aria-hidden className="absolute top-4 bottom-0 left-[5px] w-px bg-border" />
              ) : null}
              <span
                aria-hidden
                className={cn(
                  "relative mt-1.5 size-3 shrink-0 rounded-full border-2 border-background bg-muted-foreground/45 ring-1 ring-border",
                  selected && "bg-primary ring-primary/50",
                )}
              />
              <button
                className="flex min-w-0 flex-1 cursor-pointer flex-col items-start rounded-md px-2 py-1 text-left outline-none ring-ring hover:bg-accent focus-visible:ring-2"
                onClick={() => onSelect(isCurrent ? undefined : version.version)}
                type="button"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  v{version.version}
                  {isCurrent ? (
                    <Badge size="sm" variant="secondary">
                      Current
                    </Badge>
                  ) : null}
                </span>
                <span className="mt-0.5 text-xs text-muted-foreground">{version.reason}</span>
                <span className="mt-1 text-[11px] text-muted-foreground">
                  {formatDate(version.createdAt)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ArtifactInspector({
  project,
  summary,
  onBack,
}: {
  readonly project: EnvironmentProject;
  readonly summary: EnvironmentArtifactSummary;
  readonly onBack: () => void;
}) {
  const [version, setVersion] = useState<number | undefined>();
  const { detail, versions, error, isPending, refresh } = useArtifact(
    project.environmentId,
    project.id,
    summary.slug,
    version,
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-4 py-3 md:hidden">
        <Button aria-label="Back to artifacts" onClick={onBack} size="icon-sm" variant="ghost">
          <ArrowLeftIcon />
        </Button>
        <span className="truncate text-sm font-medium">{summary.name}</span>
      </div>
      <ScrollArea className="min-h-0 flex-1" radius="none" scrollbarGutter>
        {isPending && detail === null ? (
          <div className="flex flex-col gap-4 p-5 lg:p-7">
            <Skeleton className="h-7 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-64 w-full" shape="card" />
          </div>
        ) : error || detail === null ? (
          <Empty size="hero">
            <EmptyHeader>
              <EmptyTitle>Artifact unavailable</EmptyTitle>
              <EmptyDescription>{error ?? "This artifact no longer exists."}</EmptyDescription>
            </EmptyHeader>
            <Button onClick={refresh} variant="outline">
              Try again
            </Button>
          </Empty>
        ) : (
          <div className="grid min-w-0 gap-8 p-5 lg:grid-cols-[minmax(0,1fr)_15rem] lg:p-7">
            <article className="flex min-w-0 flex-col gap-5">
              <header className="flex min-w-0 flex-col gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">
                    {detail.name}
                  </h1>
                  <Badge variant="outline">{KIND_LABEL[detail.kind]}</Badge>
                  <Badge variant="secondary">v{detail.version}</Badge>
                </div>
                {detail.description ? (
                  <p className="text-sm leading-6 text-muted-foreground">{detail.description}</p>
                ) : null}
                <div className="flex flex-wrap gap-1.5">
                  {detail.tags.map((tag) => (
                    <Badge key={tag} size="sm" variant="outline">
                      {tag}
                    </Badge>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Saved {formatDate(detail.versionCreatedAt)} · {detail.versionReason}
                </p>
              </header>
              <section
                aria-labelledby="artifact-content-heading"
                className="flex min-w-0 flex-col gap-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold" id="artifact-content-heading">
                    Content
                  </h2>
                  {detail.version !== detail.currentVersion ? (
                    <span className="text-xs text-muted-foreground">Viewing history</span>
                  ) : null}
                </div>
                <ContentPreview artifact={detail} />
              </section>
            </article>
            <VersionTimeline
              currentVersion={detail.currentVersion}
              onSelect={setVersion}
              selectedVersion={version}
              versions={versions}
            />
          </div>
        )}
      </ScrollArea>
    </section>
  );
}

function ProjectLibrary({ project }: { readonly project: EnvironmentProject }) {
  const { artifacts } = useArtifacts(project.environmentId, project.id);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [showInspector, setShowInspector] = useState(false);
  const selected =
    artifacts.find((artifact) => artifact.slug === selectedSlug) ?? artifacts[0] ?? null;
  const effectiveSelectedSlug = selected?.slug ?? null;

  const selectArtifact = (slug: string) => {
    setSelectedSlug(slug);
    setShowInspector(true);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm/5">
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 md:flex md:max-w-96",
          showInspector && "hidden md:flex",
        )}
      >
        <ArtifactList
          project={project}
          selectedSlug={effectiveSelectedSlug}
          onSelect={selectArtifact}
        />
      </div>
      {selected ? (
        <div className={cn("min-h-0 min-w-0 flex-1", !showInspector && "hidden md:flex")}>
          <ArtifactInspector
            key={selected.slug}
            project={project}
            summary={selected}
            onBack={() => setShowInspector(false)}
          />
        </div>
      ) : (
        <div className="hidden min-h-0 min-w-0 flex-1 md:flex">
          <Empty size="hero">
            <EmptyMedia variant="icon">
              <LibraryBigIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>Select an artifact</EmptyTitle>
              <EmptyDescription>
                Choose an artifact to inspect its content and version history.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      )}
    </div>
  );
}

export function ArtifactLibraryPage() {
  const projects = useProjects();
  const [requestedProjectKey, setRequestedProjectKey] = useState<string | null>(null);
  const selectedProject =
    projects.find((project) => environmentProjectKey(project) === requestedProjectKey) ??
    projects[0] ??
    null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex w-full min-w-0 items-center py-2">
            <WorkspaceBreadcrumb ariaLabel="Artifact library breadcrumb">
              <WorkspaceBreadcrumbItem>
                <h1>Artifacts</h1>
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
        <main className="flex min-h-0 min-w-0 flex-1 p-3 sm:p-4">
          {selectedProject ? (
            <ProjectLibrary
              key={environmentProjectKey(selectedProject)}
              project={selectedProject}
            />
          ) : (
            <Empty size="hero">
              <EmptyMedia variant="icon">
                <LibraryBigIcon />
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>No projects available</EmptyTitle>
                <EmptyDescription>
                  Connect an environment and add a project to browse saved artifacts.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </main>
      </div>
    </SidebarInset>
  );
}
