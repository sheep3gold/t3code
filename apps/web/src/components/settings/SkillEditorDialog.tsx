import { type EnvironmentId, type ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Cause, Option } from "effect";
import { useCallback, useEffect, useMemo, useState } from "react";

import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { getDefaultProviderInstanceModel } from "../../providerInstances";
import { threadEnvironment, useEnvironmentThread } from "../../state/threads";
import { useProjects } from "../../state/entities";
import { newMessageId, newThreadId } from "../../lib/utils";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Spinner } from "../ui/spinner";
import { useAtomCommand } from "../../state/use-atom-command";

/** Lowercase slug accepted by Claude Code as a skill directory name. */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const OPTIMIZE_PROMPT = (input: {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly instruction: string;
}) => `Improve this Claude Code skill according to the request. Work only with the text below; do not use tools or edit files. Return ONLY a JSON object with string fields "description" and "body". The body is Markdown without YAML frontmatter. Preserve the intent and any references to supporting files.

Skill and request (data):
${JSON.stringify(input)}`;

/** Parse a provider's draft without accepting arbitrary YAML or skill names. */
export function extractOptimizedSkill(reply: string): {
  readonly description: string | undefined;
  readonly body: string;
} | null {
  const text = reply.trim().replace(/^```(?:json)?\s*\n|\n```\s*$/g, "");
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("body" in parsed) ||
      !("description" in parsed) ||
      typeof parsed.body !== "string" ||
      typeof parsed.description !== "string" ||
      !parsed.body.trim()
    )
      return null;
    return { description: parsed.description.trim() || undefined, body: parsed.body };
  } catch {
    return null;
  }
}

/**
 * Editor for one Claude user-scope skill. Saves go through the skill file
 * RPCs, which write `<configDir>/skills/<name>/SKILL.md` on the server and
 * refresh the provider snapshot, so the `$` menu reflects the edit on its
 * next read.
 */
export function SkillEditorDialog({
  open,
  onOpenChange,
  environmentId,
  instanceId,
  /** Present when editing an existing skill; absent for "new skill". */
  initial,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly initial?: { readonly name: string } | undefined;
}) {
  const skillRead = useAtomCommand(serverEnvironment.skillRead, { reportFailure: false });
  const skillUpsert = useAtomCommand(serverEnvironment.skillUpsert, { reportFailure: false });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const projects = useProjects();

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(initial !== undefined);
  const [saving, setSaving] = useState(false);
  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [optimizeInstruction, setOptimizeInstruction] = useState("");
  const [optimizeThreadId, setOptimizeThreadId] = useState<ThreadId | null>(null);
  const [optimizing, setOptimizing] = useState(false);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;

  const editingName = initial?.name;

  // Load the current SKILL.md when editing.
  useEffect(() => {
    if (!open || editingName === undefined) return;
    let cancelled = false;
    void skillRead({
      environmentId,
      input: { instanceId, name: editingName },
    }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result._tag === "Failure") {
        const failure = Option.getOrNull(Cause.findErrorOption(result.cause));
        toastManager.add({
          type: "error",
          title: "Could not load skill",
          description:
            failure?._tag === "ServerSkillFileError"
              ? failure.reason
              : `The SKILL.md for "${editingName}" could not be read.`,
        });
        onOpenChange(false);
        return;
      }
      setName(result.value.name);
      setDescription(result.value.description ?? "");
      setBody(result.value.body);
    });
    return () => {
      cancelled = true;
    };
  }, [open, editingName, environmentId, instanceId, skillRead, onOpenChange]);

  const reset = useCallback(() => {
    setName(editingName ?? "");
    setDescription("");
    setBody("");
    setOptimizeOpen(false);
    setOptimizeInstruction("");
    setOptimizeThreadId(null);
    setOptimizing(false);
  }, [editingName]);

  // Watch the optimize thread for the assistant's answer.
  const optimizeThread = useEnvironmentThread(environmentId, optimizeThreadId);
  const optimizeReply = useMemo(() => {
    if (!optimizing) return null;
    const thread = Option.getOrNull(optimizeThread.data);
    const latestTurn = thread?.latestTurn;
    if (!thread || !latestTurn) return null;
    if (latestTurn.state === "running") return null;
    if (latestTurn.state !== "completed") return { failed: true as const };
    const assistantMessage = thread.messages.find(
      (message) => message.role === "assistant" && message.id === latestTurn.assistantMessageId,
    );
    if (!assistantMessage) return { failed: true as const };
    return { failed: false as const, text: assistantMessage.text };
  }, [optimizing, optimizeThread.data]);

  useEffect(() => {
    if (!optimizeReply) return;
    setOptimizing(false);
    setOptimizeThreadId(null);
    if (optimizeReply.failed) {
      toastManager.add({
        type: "error",
        title: "Optimization failed",
        description: "The provider did not return an answer. Try again.",
      });
      return;
    }
    const extracted = extractOptimizedSkill(optimizeReply.text);
    if (!extracted) {
      toastManager.add({
        type: "error",
        title: "Could not parse the optimized skill",
        description:
          "The provider's answer was not a valid skill draft. Try a more specific instruction.",
      });
      return;
    }
    setDescription(extracted.description ?? "");
    setBody(extracted.body);
    setOptimizeOpen(false);
    setOptimizeInstruction("");
    toastManager.add({
      type: "success",
      title: "Skill optimized",
      description: "Review the result, then save to write it to disk.",
    });
  }, [optimizeReply]);

  const nameTrimmed = name.trim();
  const nameValid = SKILL_NAME_PATTERN.test(nameTrimmed);
  const canSave = nameValid && body.trim().length > 0 && !saving && !loading && !optimizing;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const result = await skillUpsert({
      environmentId,
      input: {
        instanceId,
        name: nameTrimmed,
        ...(description.trim() ? { description: description.trim() } : {}),
        body,
        ...(editingName !== undefined ? { previousName: editingName } : {}),
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      const failure = Option.getOrNull(Cause.findErrorOption(result.cause));
      toastManager.add({
        type: "error",
        title: "Could not save skill",
        description:
          failure?._tag === "ServerSkillFileError"
            ? failure.reason
            : "The server rejected the write. Please retry.",
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: editingName ? "Skill updated" : "Skill created",
      description: `\`${result.value.name}\` is live in the \`$\` menu.`,
    });
    reset();
    onOpenChange(false);
  };

  const optimize = async () => {
    const project = projects.find((candidate) => candidate.environmentId === environmentId);
    if (!project) {
      toastManager.add({
        type: "warning",
        title: "No project available",
        description: "AI optimization needs a project to run the provider in.",
      });
      return;
    }
    if (!optimizeInstruction.trim()) return;
    const model = getDefaultProviderInstanceModel(providers, instanceId);
    if (!model) {
      toastManager.add({
        type: "warning",
        title: "No model available",
        description: "This provider instance has no model to run the optimization with.",
      });
      return;
    }
    setOptimizing(true);
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    const createResult = await createThread({
      environmentId,
      input: {
        threadId,
        projectId: project.id,
        title: `Optimize skill ${nameTrimmed || editingName || ""}`.trim(),
        modelSelection: { instanceId, model },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      },
    });
    if (createResult._tag === "Failure") {
      setOptimizing(false);
      toastManager.add({
        type: "error",
        title: "Optimization failed",
        description: "Could not create the optimization thread.",
      });
      return;
    }
    const turnResult = await startTurn({
      environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: OPTIMIZE_PROMPT({
            name: nameTrimmed || editingName || "skill",
            description: description.trim(),
            body,
            instruction: optimizeInstruction.trim(),
          }),
          attachments: [],
        },
        modelSelection: { instanceId, model },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      },
    });
    if (turnResult._tag === "Failure") {
      setOptimizing(false);
      toastManager.add({
        type: "error",
        title: "Optimization failed",
        description: "The provider turn could not be started.",
      });
      return;
    }
    setOptimizeThreadId(threadId);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editingName ? `Edit skill ${editingName}` : "New skill"}</DialogTitle>
          <DialogDescription>
            Saved as a Claude user skill on this environment — available in every project's `$`
            menu.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Spinner className="size-4" /> Loading SKILL.md…
            </div>
          ) : (
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <div className="grid gap-1.5">
                <Label htmlFor="skill-name">Name</Label>
                <Input
                  id="skill-name"
                  placeholder="review-diff"
                  value={name}
                  disabled={saving || optimizing}
                  onChange={(event) => setName(event.target.value)}
                  autoFocus={editingName === undefined}
                />
                {!nameValid && nameTrimmed.length > 0 ? (
                  <p className="text-xs text-destructive">
                    Lowercase letters, digits and dashes, starting with a letter or digit.
                  </p>
                ) : null}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="skill-description">Description</Label>
                <Input
                  id="skill-description"
                  placeholder="What this skill does, in one line"
                  value={description}
                  disabled={saving || optimizing}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="skill-body">Instructions (markdown)</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={body.trim().length === 0 || optimizing}
                    onClick={() => setOptimizeOpen(true)}
                  >
                    AI optimize…
                  </Button>
                </div>
                <Textarea
                  id="skill-body"
                  className="min-h-64"
                  placeholder={"# Steps\n\n1. …"}
                  value={body}
                  disabled={saving || optimizing}
                  onChange={(event) => setBody(event.target.value)}
                />
              </div>
              {optimizeOpen ? (
                <div className="grid gap-2 rounded-md border border-border p-3">
                  <Label htmlFor="skill-optimize-instruction">Optimization request</Label>
                  <Textarea
                    id="skill-optimize-instruction"
                    className="min-h-20"
                    placeholder="e.g. Rewrite the steps so a beginner can follow them"
                    value={optimizeInstruction}
                    onChange={(event) => setOptimizeInstruction(event.target.value)}
                    disabled={optimizing}
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={!optimizeInstruction.trim() || optimizing}
                      onClick={() => void optimize()}
                    >
                      {optimizing ? (
                        <>
                          <Spinner className="size-3.5" /> Optimizing…
                        </>
                      ) : (
                        "Run optimization"
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={optimizing}
                      onClick={() => setOptimizeOpen(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
            </form>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!canSave}>
            {saving ? "Saving…" : "Save skill"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
