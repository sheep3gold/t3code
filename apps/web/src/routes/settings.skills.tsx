import { createFileRoute } from "@tanstack/react-router";

import { SkillsSettingsPanel } from "../components/settings/SkillsSettingsPanel";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

/**
 * Skills live in the environment's server settings and are discovered by that
 * environment's providers, so the page shows one environment at a time: the
 * chosen one, or the representative of the selection.
 */
function SettingsSkillsRoute() {
  const { environment, scope } = useSettingsScope();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to manage its skills.`
          : "Connect an environment to manage its skills."}
      </p>
    );
  }
  return <SkillsSettingsPanel environmentId={environment.environmentId} />;
}

export const Route = createFileRoute("/settings/skills")({
  component: SettingsSkillsRoute,
});
