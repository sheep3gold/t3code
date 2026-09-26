import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentArtifactKind, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useArtifact, useArtifacts } from "../../state/artifacts";
import { SettingsEnvironmentFilterHeader } from "../settings/components/SettingsEnvironmentFilterHeader";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useSettingsEnvironmentFilter } from "../settings/settings-environment-filter";

const KIND_LABEL: Record<EnvironmentArtifactKind, string> = {
  text: "Text",
  markdown: "Markdown",
  json: "JSON",
  html: "HTML",
  svg: "SVG",
};

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export function SettingsArtifactsRouteScreen() {
  const navigation = useNavigation();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const projectGroup = projectGroups.find((group) => group.key === selectedProjectKey);
  const project = projectGroup?.members
    .map((member) => member.project)
    .find((candidate) =>
      selectedTargets.some((target) => target.environmentId === candidate.environmentId),
    );

  if (!project) {
    return (
      <SettingsScreen title="Artifacts">
        <SettingsEnvironmentFilterHeader />
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-base text-foreground-muted">
            Select a project to browse its saved artifacts.
          </Text>
        </View>
      </SettingsScreen>
    );
  }

  return (
    <ArtifactList
      project={project}
      onOpen={(slug) =>
        navigation.navigate("SettingsSheet", {
          screen: "SettingsContent",
          params: {
            screen: "SettingsArtifactDetail",
            params: { environmentId: project.environmentId, projectId: project.id, slug },
          },
        })
      }
    />
  );
}

function ArtifactList({
  project,
  onOpen,
}: {
  readonly project: {
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly title: string;
  };
  readonly onOpen: (slug: string) => void;
}) {
  const { artifacts, error, isPending, refresh } = useArtifacts(project.environmentId, project.id);
  return (
    <SettingsScreen title="Artifacts">
      <SettingsEnvironmentFilterHeader />
      <ScrollView
        className="flex-1 bg-sheet"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-5 py-4"
        refreshControl={undefined}
      >
        <SettingsSection title={project.title}>
          {artifacts.map((artifact) => (
            <SettingsRow
              key={artifact.slug}
              icon="doc.text"
              label={artifact.name}
              value={`${KIND_LABEL[artifact.kind]} · v${artifact.currentVersion}`}
              onPress={() => onOpen(artifact.slug)}
            />
          ))}
        </SettingsSection>
        {isPending && artifacts.length === 0 ? (
          <ActivityIndicator accessibilityLabel="Loading artifacts" />
        ) : null}
        {error ? (
          <Pressable
            accessibilityRole="button"
            className="rounded-xl bg-grouped-card p-4"
            onPress={refresh}
          >
            <Text className="font-t3-semibold text-foreground">Artifacts unavailable</Text>
            <Text className="mt-1 text-sm text-foreground-muted">{error} Tap to retry.</Text>
          </Pressable>
        ) : null}
        {!isPending && !error && artifacts.length === 0 ? (
          <View className="items-center gap-2 px-8 py-16">
            <SymbolView name="archivebox" size={30} tintColorClassName="accent-icon" />
            <Text className="font-t3-semibold text-foreground">No artifacts yet</Text>
            <Text className="text-center text-sm text-foreground-muted">
              Artifacts saved by agents for this project will appear here.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}

type DetailParams = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly slug: string;
};

export function SettingsArtifactDetailRouteScreen({ route }: StaticScreenProps<DetailParams>) {
  const params = route.params;
  const [version, setVersion] = useState<number | undefined>();
  const { detail, versions, error, isPending } = useArtifact(
    params.environmentId,
    params.projectId,
    params.slug,
    version,
  );
  return (
    <SettingsScreen title={detail?.name ?? "Artifact"}>
      <ScrollView
        className="flex-1 bg-sheet"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 px-5 py-4"
      >
        {isPending && !detail ? <ActivityIndicator accessibilityLabel="Loading artifact" /> : null}
        {error ? <Text className="text-base text-destructive">{error}</Text> : null}
        {detail ? (
          <>
            <View className="gap-2 rounded-2xl bg-grouped-card p-4">
              <View className="flex-row flex-wrap items-center gap-2">
                <Text className="text-xl font-t3-bold text-foreground">{detail.name}</Text>
                <Text className="text-sm text-foreground-muted">
                  {KIND_LABEL[detail.kind]} · v{detail.version}
                </Text>
              </View>
              {detail.description ? (
                <Text className="text-base text-foreground-muted">{detail.description}</Text>
              ) : null}
              <Text className="text-xs text-foreground-muted">
                {detail.versionReason} · {formatDate(detail.versionCreatedAt)}
              </Text>
            </View>
            <SettingsSection title="Content">
              <View className="rounded-2xl bg-grouped-card p-4">
                <Text selectable className="font-mono text-sm leading-5 text-foreground">
                  {detail.content}
                </Text>
              </View>
            </SettingsSection>
            <SettingsSection title="Versions">
              {versions.map((item) => (
                <SettingsRow
                  key={item.version}
                  icon={item.version === detail.currentVersion ? "checkmark.circle" : "clock"}
                  label={`Version ${item.version}${item.version === detail.currentVersion ? " · Current" : ""}`}
                  value={`${item.reason} · ${formatDate(item.createdAt)}`}
                  onPress={() =>
                    setVersion(item.version === detail.currentVersion ? undefined : item.version)
                  }
                />
              ))}
            </SettingsSection>
          </>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}
