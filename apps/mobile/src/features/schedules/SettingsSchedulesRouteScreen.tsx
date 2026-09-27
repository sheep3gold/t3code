import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadSchedule } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThreadShells } from "../../state/entities";
import { scheduleEnvironment, useSchedules } from "../../state/schedules";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsEnvironmentFilterHeader } from "../settings/components/SettingsEnvironmentFilterHeader";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useSettingsEnvironmentFilter } from "../settings/settings-environment-filter";

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function formatInterval(seconds: number | null): string {
  if (!seconds) return "Repeats";
  if (seconds % 86_400 === 0) return `Every ${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `Every ${seconds / 3_600}h`;
  return `Every ${Math.round(seconds / 60)}m`;
}

function mutationMessage(result: unknown): string {
  if (result instanceof Error && result.message.trim()) return result.message;
  return "The schedule operation failed.";
}

export function SettingsSchedulesRouteScreen() {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const projectGroup = projectGroups.find((group) => group.key === selectedProjectKey);
  const project = projectGroup?.members
    .map((member) => member.project)
    .find((candidate) =>
      selectedTargets.some((target) => target.environmentId === candidate.environmentId),
    );
  const allThreads = useThreadShells();
  const threads = useMemo(
    () =>
      project
        ? [...allThreads]
            .filter(
              (thread) =>
                thread.environmentId === project.environmentId &&
                thread.projectId === project.id &&
                thread.archivedAt === null,
            )
            .sort((left, right) => left.title.localeCompare(right.title))
        : [],
    [allThreads, project],
  );

  if (!project) {
    return (
      <SettingsScreen title="Schedules">
        <SettingsEnvironmentFilterHeader />
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-base text-foreground-muted">
            Select a project to manage its scheduled agent tasks.
          </Text>
        </View>
      </SettingsScreen>
    );
  }

  return <ProjectSchedules project={project} threads={threads} />;
}

function ProjectSchedules({
  project,
  threads,
}: {
  readonly project: EnvironmentProject;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const { schedules, error, isPending, refresh } = useSchedules(project.environmentId, project.id);
  const pause = useAtomCommand(scheduleEnvironment.pause, { reportFailure: false });
  const resume = useAtomCommand(scheduleEnvironment.resume, { reportFailure: false });
  const remove = useAtomCommand(scheduleEnvironment.remove, { reportFailure: false });
  const [createOpen, setCreateOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const mutate = async (
    schedule: EnvironmentThreadSchedule,
    action: "pause" | "resume" | "remove",
  ) => {
    setBusyId(schedule.id);
    const target = {
      environmentId: project.environmentId,
      input: { projectId: project.id, scheduleId: schedule.id },
    };
    const result =
      action === "pause"
        ? await pause(target)
        : action === "resume"
          ? await resume(target)
          : await remove(target);
    setBusyId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Alert.alert("Schedule operation failed", mutationMessage(squashAtomCommandFailure(result)));
    }
  };

  return (
    <SettingsScreen title="Schedules">
      <SettingsEnvironmentFilterHeader />
      <ScrollView
        className="flex-1 bg-sheet"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-5 py-4"
      >
        <Pressable
          accessibilityRole="button"
          className="flex-row items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3"
          disabled={threads.length === 0}
          onPress={() => setCreateOpen(true)}
        >
          <SymbolView name="plus" size={16} tintColorClassName="accent-foreground" />
          <Text className="font-t3-semibold text-accent-foreground">New schedule</Text>
        </Pressable>
        <SettingsSection title={project.title}>
          {schedules.map((schedule) => (
            <View
              key={schedule.id}
              className="gap-3 border-b border-border-subtle bg-grouped-card px-4 py-3 last:border-b-0"
            >
              <View className="flex-row items-start justify-between gap-3">
                <View className="min-w-0 flex-1 gap-1">
                  <Text className="font-t3-semibold text-foreground">{schedule.threadTitle}</Text>
                  <Text className="text-sm text-foreground-muted">{schedule.prompt}</Text>
                  <Text className="text-xs text-foreground-muted">
                    {schedule.status === "paused"
                      ? "Paused"
                      : schedule.status === "completed"
                        ? "Completed"
                        : schedule.scheduleKind === "interval"
                          ? formatInterval(schedule.intervalSeconds)
                          : formatDate(schedule.nextRunAt)}
                  </Text>
                </View>
                {busyId === schedule.id ? <ActivityIndicator /> : null}
              </View>
              <View className="flex-row justify-end gap-2">
                {schedule.status === "active" ? (
                  <Action label="Pause" onPress={() => void mutate(schedule, "pause")} />
                ) : null}
                {schedule.status === "paused" ? (
                  <Action label="Resume" onPress={() => void mutate(schedule, "resume")} />
                ) : null}
                <Action
                  destructive
                  label="Delete"
                  onPress={() =>
                    Alert.alert("Delete schedule?", "This task will stop running.", [
                      { text: "Keep", style: "cancel" },
                      {
                        text: "Delete",
                        style: "destructive",
                        onPress: () => void mutate(schedule, "remove"),
                      },
                    ])
                  }
                />
              </View>
            </View>
          ))}
        </SettingsSection>
        {isPending && schedules.length === 0 ? (
          <ActivityIndicator accessibilityLabel="Loading schedules" />
        ) : null}
        {error ? (
          <Pressable
            accessibilityRole="button"
            className="rounded-xl bg-grouped-card p-4"
            onPress={refresh}
          >
            <Text className="font-t3-semibold text-foreground">Schedules unavailable</Text>
            <Text className="mt-1 text-sm text-foreground-muted">{error} Tap to retry.</Text>
          </Pressable>
        ) : null}
        {!isPending && !error && schedules.length === 0 ? (
          <View className="items-center gap-2 px-8 py-16">
            <SymbolView name="clock" size={30} tintColorClassName="accent-icon" />
            <Text className="font-t3-semibold text-foreground">No scheduled tasks</Text>
            <Text className="text-center text-sm text-foreground-muted">
              Create a one-time or recurring task for this project.
            </Text>
          </View>
        ) : null}
      </ScrollView>
      <CreateScheduleModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        project={project}
        threads={threads}
      />
    </SettingsScreen>
  );
}

function Action({
  label,
  destructive = false,
  onPress,
}: {
  readonly label: string;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      className="rounded-lg bg-fill-secondary px-3 py-2"
      onPress={onPress}
    >
      <Text
        className={
          destructive ? "font-t3-semibold text-destructive" : "font-t3-semibold text-foreground"
        }
      >
        {label}
      </Text>
    </Pressable>
  );
}

function CreateScheduleModal({
  open,
  onClose,
  project,
  threads,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly project: EnvironmentProject;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const create = useAtomCommand(scheduleEnvironment.create, { reportFailure: false });
  const [threadId, setThreadId] = useState<EnvironmentThreadShell["id"] | null>(
    threads[0]?.id ?? null,
  );
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"once" | "interval">("once");
  const [minutes, setMinutes] = useState("60");
  const [submitting, setSubmitting] = useState(false);
  const submit = async () => {
    const value = Number(minutes);
    if (!threadId || !prompt.trim() || !Number.isInteger(value) || value < 1) {
      Alert.alert("Complete the schedule", "Choose a thread, enter a task, and use whole minutes.");
      return;
    }
    setSubmitting(true);
    const result = await create({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        threadId,
        prompt: prompt.trim(),
        ...(mode === "once" ? { delaySeconds: value * 60 } : { everySeconds: value * 60 }),
      },
    });
    setSubmitting(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        Alert.alert("Could not create schedule", mutationMessage(squashAtomCommandFailure(result)));
      return;
    }
    onClose();
  };
  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={open}
    >
      <SettingsScreen title="New schedule">
        <ScrollView
          className="flex-1 bg-sheet"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-5 px-5 py-5"
        >
          <SettingsSection title="Thread">
            {threads.map((thread) => (
              <SettingsRow
                key={thread.id}
                icon={thread.id === threadId ? "checkmark.circle" : "clock"}
                label={thread.title}
                onPress={() => setThreadId(thread.id)}
              />
            ))}
          </SettingsSection>
          <View className="gap-2">
            <Text className="font-t3-semibold text-foreground">Task</Text>
            <TextInput
              multiline
              className="min-h-28 rounded-xl bg-grouped-card px-4 py-3 text-foreground"
              placeholder="Describe what the agent should do."
              placeholderTextColorClassName="foreground-muted"
              value={prompt}
              onChangeText={setPrompt}
            />
          </View>
          <View className="flex-row gap-2">
            <Action
              label={mode === "once" ? "✓ Run once" : "Run once"}
              onPress={() => setMode("once")}
            />
            <Action
              label={mode === "interval" ? "✓ Repeat" : "Repeat"}
              onPress={() => setMode("interval")}
            />
          </View>
          <View className="gap-2">
            <Text className="font-t3-semibold text-foreground">
              {mode === "once" ? "Run after (minutes)" : "Repeat every (minutes)"}
            </Text>
            <TextInput
              keyboardType="number-pad"
              className="rounded-xl bg-grouped-card px-4 py-3 text-foreground"
              value={minutes}
              onChangeText={setMinutes}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            className="items-center rounded-xl bg-accent px-4 py-3"
            disabled={submitting}
            onPress={() => void submit()}
          >
            <Text className="font-t3-semibold text-accent-foreground">
              {submitting ? "Creating…" : "Create schedule"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            className="items-center px-4 py-3"
            onPress={onClose}
          >
            <Text className="font-t3-semibold text-foreground-muted">Cancel</Text>
          </Pressable>
        </ScrollView>
      </SettingsScreen>
    </Modal>
  );
}
