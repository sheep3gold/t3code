import {
  type EnvironmentId,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

interface SkillRow {
  /** Display name; identity for the disabled set is its lowercase form. */
  readonly name: string;
  readonly description: string | undefined;
  /** Labels of the provider instances that discovered this skill. */
  readonly providerLabels: ReadonlyArray<string>;
}

function collectSkillRows(providers: ReadonlyArray<ServerProvider>): ReadonlyArray<SkillRow> {
  const rows = new Map<string, SkillRow>();
  for (const provider of providers) {
    if (!provider.enabled) continue;
    const providerLabel = provider.displayName ?? provider.instanceId;
    const discovered: ReadonlyArray<ServerProviderSkill> = [
      ...provider.skills,
      ...(provider.workspaceSnapshots ?? []).flatMap((snapshot) => snapshot.skills),
    ];
    for (const skill of discovered) {
      const key = skill.name.trim().toLowerCase();
      if (!key) continue;
      const existing = rows.get(key);
      if (existing) {
        if (!existing.providerLabels.includes(providerLabel)) {
          rows.set(key, {
            ...existing,
            providerLabels: [...existing.providerLabels, providerLabel],
          });
        }
        continue;
      }
      rows.set(key, {
        name: skill.name,
        description: skill.description ?? skill.shortDescription,
        providerLabels: [providerLabel],
      });
    }
  }
  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * One switch per discovered skill, stored globally in the environment's
 * `disabledSkills`. Turning a skill off removes it from every provider
 * snapshot the server publishes: the `$` menu stops offering it and a
 * hand-typed `$name` mention is sent as literal text instead of dispatching.
 *
 * The collapsed row shows only the name plus the switch; the long description
 * and the list of discovering providers sit in a per-row expand panel so a
 * 20-skill environment fits on one screen without scrolling.
 */
export function SkillsSettingsPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;

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
        .map((name) => ({ name, description: undefined, providerLabels: [] }) satisfies SkillRow),
    [disabledSkills, skillRows],
  );

  const [openName, setOpenName] = useState<string | null>(null);

  const setSkillDisabled = (name: string, disabled: boolean) => {
    const key = name.trim().toLowerCase();
    const next = disabled
      ? [...disabledSkills.filter((entry) => entry.trim().toLowerCase() !== key), name]
      : disabledSkills.filter((entry) => entry.trim().toLowerCase() !== key);
    updateSettings({ disabledSkills: next });
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
          menu and blocks `$name` mentions from dispatching it, across every provider.
        </p>
        {skillRows.length === 0 && undiscoveredDisabled.length === 0 ? (
          <p className="px-3 py-6 text-sm text-muted-foreground sm:px-4">
            No skills discovered yet. Skills appear here once a provider reports them — open a
            project's composer and type `$` to trigger a workspace scan.
          </p>
        ) : (
          <div className="text-base sm:text-sm">
            {skillRows.map(renderRow)}
            {undiscoveredDisabled.map(renderRow)}
          </div>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
