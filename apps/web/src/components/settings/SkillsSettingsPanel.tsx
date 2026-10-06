import { type EnvironmentId, type ProviderInstanceId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Cause, Option } from "effect";
import { ChevronRightIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { collectSkillRows, filterSkillRows, type SkillRow } from "../../skillsFilter";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { SkillEditorDialog } from "./SkillEditorDialog";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * One switch per discovered skill, stored globally in the environment's
 * `disabledSkills`. Turning a skill off removes it from every provider
 * snapshot the server publishes: the `$` menu stops offering it and a
 * hand-typed `$name` mention is sent as literal text instead of dispatching.
 *
 * Claude user-scope skills can also be edited and deleted here: those write
 * the SKILL.md under the instance's config dir on the server, which is the
 * same file `discoverClaudeSkills` scans, so the `$` menu follows the edit.
 */
export function SkillsSettingsPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const skillDelete = useAtomCommand(serverEnvironment.skillDelete, { reportFailure: false });
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;

  const [query, setQuery] = useState("");
  const [selectedClaudeInstanceId, setSelectedClaudeInstanceId] =
    useState<ProviderInstanceId | null>(null);
  const [openName, setOpenName] = useState<string | null>(null);
  const [editor, setEditor] = useState<{
    readonly instanceId: ProviderInstanceId;
    readonly name?: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SkillRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const onEditorOpenChange = useCallback((next: boolean) => {
    if (!next) setEditor(null);
  }, []);

  const disabledSkills = settings.disabledSkills;
  const disabledSkillNames = useMemo(
    () => new Set(disabledSkills.map((name) => name.trim().toLowerCase())),
    [disabledSkills],
  );
  const skillRows = useMemo(() => collectSkillRows(providers), [providers]);
  // Disabled entries nothing currently discovers stay listed so the user can
  // turn them back on without re-adding the skill first.
  const undiscoveredDisabled = useMemo(
    () =>
      disabledSkills
        .filter(
          (name) =>
            !skillRows.some((row) => row.name.trim().toLowerCase() === name.trim().toLowerCase()),
        )
        .map(
          (name) =>
            ({
              name,
              description: undefined,
              providerLabels: [],
              editableInstanceId: undefined,
            }) satisfies SkillRow,
        ),
    [disabledSkills, skillRows],
  );

  const filteredRows = useMemo(() => filterSkillRows(skillRows, query), [skillRows, query]);
  const filteredUndiscovered = useMemo(
    () => filterSkillRows(undiscoveredDisabled, query),
    [undiscoveredDisabled, query],
  );

  const claudeInstances = useMemo(
    () => providers.filter((provider) => provider.driver === "claudeAgent" && provider.enabled),
    [providers],
  );
  const newSkillInstanceId =
    claudeInstances.length === 1
      ? claudeInstances[0]!.instanceId
      : (claudeInstances.find((provider) => provider.instanceId === selectedClaudeInstanceId)
          ?.instanceId ?? null);

  const setSkillDisabled = (name: string, disabled: boolean) => {
    const key = name.trim().toLowerCase();
    const next = disabled
      ? [...disabledSkills.filter((entry) => entry.trim().toLowerCase() !== key), name]
      : disabledSkills.filter((entry) => entry.trim().toLowerCase() !== key);
    updateSettings({ disabledSkills: next });
  };

  const confirmDelete = async () => {
    if (!deleteTarget?.editableInstanceId) return;
    setDeleting(true);
    const result = await skillDelete({
      environmentId,
      input: { instanceId: deleteTarget.editableInstanceId, name: deleteTarget.name },
    });
    setDeleting(false);
    if (result._tag === "Failure") {
      const failure = Option.getOrNull(Cause.findErrorOption(result.cause));
      toastManager.add({
        type: "error",
        title: "Could not delete skill",
        description:
          failure?._tag === "ServerSkillFileError"
            ? failure.reason
            : `The SKILL.md for "${deleteTarget.name}" could not be archived.`,
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: "Skill deleted",
      description: `\`${deleteTarget.name}\` was removed from this environment.`,
    });
    setDeleteTarget(null);
  };

  const renderRow = (row: SkillRow) => {
    const disabled = disabledSkillNames.has(row.name.trim().toLowerCase());
    const rowKey = row.name.trim().toLowerCase();
    const open = openName === rowKey;
    const detailText = [
      row.description,
      row.providerLabels.length > 0
        ? `From ${row.providerLabels.join(", ")}`
        : "Not discovered by any provider right now",
      row.editableInstanceId === undefined && row.providerLabels.length > 0
        ? "Read-only: only Claude user skills can be edited here."
        : undefined,
    ]
      .filter(Boolean)
      .join("\n\n");
    return (
      <Collapsible
        key={rowKey}
        open={open}
        onOpenChange={(next) => setOpenName(next ? rowKey : null)}
      >
        <article>
          <div className="flex min-h-10 items-center hover:bg-muted/35 sm:min-h-9">
            <CollapsibleTrigger
              aria-label={`Show details for skill ${row.name}`}
              className="group flex min-h-10 min-w-0 flex-1 items-center gap-2.5 px-3 text-left sm:min-h-9 sm:px-4"
            >
              <ChevronRightIcon
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-panel-open:rotate-90"
              />
              <span className="truncate font-medium text-foreground">{row.name}</span>
            </CollapsibleTrigger>
            <div className="me-3 shrink-0 sm:me-4">
              <Switch
                checked={!disabled}
                onCheckedChange={(checked) => setSkillDisabled(row.name, !checked)}
                aria-label={`Enable skill ${row.name}`}
              />
            </div>
          </div>
          <CollapsiblePanel>
            {open ? (
              <div className="px-9 pt-1 pb-4 sm:px-10">
                <p className="max-w-[72ch] whitespace-pre-wrap text-[13px] leading-[1.5] text-muted-foreground">
                  {detailText}
                </p>
                {row.editableInstanceId !== undefined ? (
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="compact"
                      onClick={() =>
                        setEditor({ instanceId: row.editableInstanceId!, name: row.name })
                      }
                    >
                      <PencilIcon aria-hidden /> Edit
                    </Button>
                    <Button
                      variant="destructive-outline"
                      size="compact"
                      onClick={() => setDeleteTarget(row)}
                    >
                      <Trash2Icon aria-hidden /> Delete
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </CollapsiblePanel>
        </article>
      </Collapsible>
    );
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Skills">
        <p className="px-3 pb-1 text-xs text-muted-foreground sm:px-4">
          Skills providers discovered on this environment. Turning one off hides it from the `$`
          menu and blocks `$name` mentions from dispatching it, across every provider. Claude user
          skills can be edited and deleted here; the change lands in every project's `$` menu.
        </p>
        <div className="flex items-center gap-2 px-3 pb-3 pt-2 sm:px-4">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search skills…"
            aria-label="Search skills"
            className="max-w-72"
          />
          {claudeInstances.length > 1 ? (
            <Select
              items={claudeInstances.map((provider) => ({
                value: provider.instanceId,
                label: provider.displayName ?? provider.instanceId,
              }))}
              value={newSkillInstanceId}
              onValueChange={(value) => setSelectedClaudeInstanceId(value)}
            >
              <SelectTrigger size="sm" aria-label="Claude instance for new skill">
                <SelectValue placeholder="Choose Claude instance" />
              </SelectTrigger>
              <SelectPopup>
                {claudeInstances.map((provider) => (
                  <SelectItem key={provider.instanceId} value={provider.instanceId}>
                    {provider.displayName ?? provider.instanceId}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          {claudeInstances.length > 0 ? (
            <Button
              variant="outline"
              size="compact"
              disabled={!newSkillInstanceId}
              onClick={() => {
                if (newSkillInstanceId) setEditor({ instanceId: newSkillInstanceId });
              }}
            >
              <PlusIcon aria-hidden /> New skill
            </Button>
          ) : null}
        </div>
        {filteredRows.length === 0 && filteredUndiscovered.length === 0 ? (
          <p className="px-3 py-6 text-sm text-muted-foreground sm:px-4">
            {skillRows.length === 0 && undiscoveredDisabled.length === 0
              ? "No skills discovered yet. Skills appear here once a provider reports them — open a project's composer and type `$` to trigger a workspace scan."
              : `No skills match "${query.trim()}".`}
          </p>
        ) : (
          <div className="text-base sm:text-sm">
            {filteredRows.map(renderRow)}
            {filteredUndiscovered.map(renderRow)}
          </div>
        )}
      </SettingsSection>

      {editor ? (
        <SkillEditorDialog
          open
          onOpenChange={onEditorOpenChange}
          environmentId={environmentId}
          instanceId={editor.instanceId}
          {...(editor.name !== undefined ? { initial: { name: editor.name } } : {})}
        />
      ) : null}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete skill {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This archives the skill and its files under the Claude config directory, removing it
              from the `$` menu. Other providers' skills are not changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" disabled={deleting} />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete skill"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}
