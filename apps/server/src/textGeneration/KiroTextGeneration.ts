/**
 * KiroTextGeneration — commit messages, PR content, branch names and thread
 * titles via kiro-cli.
 *
 * Deliberately NOT over ACP. These are one-shot, tool-free text generations,
 * and `kiro-cli chat --no-interactive --output-format stream-json` already
 * emits a `runFinished` line carrying the complete answer in `finalText`. That
 * is a single short-lived process per call; standing up an ACP session (as the
 * Grok text generator has to) would cost a handshake, a session create and a
 * teardown to produce one sentence.
 *
 * Two flags are load-bearing:
 *
 *   * `--trust-tools=` (empty) — these operations must never touch the
 *     filesystem or run commands. A title generator that can edit files is a
 *     liability, not a feature.
 *   * `--agent-engine` — the v1 engine cannot emit stream-json at all, so it is
 *     pinned from settings the same way the ACP path pins it.
 *
 * Output is requested as JSON and parsed defensively: a model asked for JSON
 * still sometimes wraps it in prose or a fenced block, and failing the whole
 * operation over that would make titles flaky for no reason.
 *
 * @module textGeneration/KiroTextGeneration
 */
import { TextGenerationError, type KiroSettings, type ModelSelection } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectStreamAsString } from "../provider/providerSnapshot.ts";
import { kiroTextGenerationModel } from "../provider/acp/KiroAcpSupport.ts";
import type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
} from "./TextGeneration.ts";

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

/**
 * Generous but bounded. These prompts include diffs, so a large change can take
 * a while; without a ceiling a wedged CLI would hang the caller forever.
 */
const GENERATION_TIMEOUT_MS = 90_000;

/** Keep diffs from blowing past the model's context on a large change. */
const MAX_PATCH_CHARS = 24_000;

function clip(value: string, max = MAX_PATCH_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… [truncated]`;
}

/** Project rule: parse JSON through Schema rather than bare `JSON.parse`. */
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
/** Project rule: Schema types are matched with `Schema.is`, not `instanceof`. */
const isTextGenerationError = Schema.is(TextGenerationError);

/**
 * Pull a JSON object out of model output.
 *
 * Tries the whole string first, then a fenced block, then the outermost
 * brace-delimited span. Models asked for JSON comply most of the time but not
 * always, and a title is not worth failing an operation over.
 */
const parseJsonObject = (text: string): Effect.Effect<Record<string, unknown> | undefined> =>
  Effect.gen(function* () {
    const candidates: string[] = [text.trim()];

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced?.[1]) candidates.push(fenced[1].trim());

    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.push(text.slice(firstBrace, lastBrace + 1));
    }

    for (const candidate of candidates) {
      const parsed = yield* decodeUnknownJson(candidate).pipe(Effect.option);
      if (Option.isSome(parsed)) {
        const value = parsed.value;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return value as Record<string, unknown>;
        }
      }
    }
    return undefined;
  });

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export const makeKiroTextGeneration = Effect.fn("makeKiroTextGeneration")(function* (
  kiroSettings: KiroSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  /** Run one non-interactive generation and return the model's final text. */
  const runKiroText = (input: {
    readonly operation: TextGenerationOp;
    readonly cwd: string;
    readonly prompt: string;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<string, TextGenerationError> =>
    Effect.gen(function* () {
      const binaryPath = kiroSettings.binaryPath?.trim() || "kiro-cli";
      const model = kiroTextGenerationModel(input.modelSelection.model);
      const args = [
        "chat",
        "--no-interactive",
        // No tools at all: generation must not read or write the workspace.
        "--trust-tools=",
        "--agent-engine",
        kiroSettings.agentEngine ?? "v2",
        "--model",
        model,
        "--output-format",
        "stream-json",
        input.prompt,
      ];

      const spawnCommand = yield* resolveSpawnCommand(binaryPath, args, { env: environment });
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: environment,
          shell: spawnCommand.shell,
          cwd: input.cwd,
        }),
      );
      const stdout = yield* collectStreamAsString(child.stdout);

      // The run's answer is on the `runFinished` line. Scanning from the end
      // finds it without parsing every delta line that precedes it.
      const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line) continue;
        const decoded = yield* decodeUnknownJson(line).pipe(Effect.option);
        if (Option.isNone(decoded)) continue;
        const event = decoded.value;
        if (
          event &&
          typeof event === "object" &&
          (event as { type?: unknown }).type === "runFinished"
        ) {
          const data = (event as { data?: { finalText?: unknown } }).data;
          const finalText = data?.finalText;
          if (typeof finalText === "string" && finalText.trim().length > 0) {
            return finalText.trim();
          }
        }
      }

      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "Kiro CLI produced no final text.",
      });
    }).pipe(
      Effect.scoped,
      // `timeoutOption` rather than a failing timeout: it keeps the error
      // channel to TextGenerationError alone, so a timeout reads the same as
      // any other generation failure to the caller.
      Effect.timeoutOption(GENERATION_TIMEOUT_MS),
      Effect.flatMap((result) =>
        Option.isSome(result)
          ? Effect.succeed(result.value)
          : Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: `Kiro CLI did not answer within ${GENERATION_TIMEOUT_MS}ms.`,
              }),
            ),
      ),
      Effect.catchIf(
        (error) => !isTextGenerationError(error),
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: `Kiro CLI generation failed: ${String(cause)}`,
          }),
      ),
    );

  const runJson = (input: {
    readonly operation: TextGenerationOp;
    readonly cwd: string;
    readonly prompt: string;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<Record<string, unknown>, TextGenerationError> =>
    runKiroText(input).pipe(
      Effect.flatMap((text) => parseJsonObject(text)),
      Effect.flatMap((parsed) =>
        parsed
          ? Effect.succeed(parsed)
          : Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "Kiro CLI did not return a JSON object.",
              }),
            ),
      ),
    );

  const generateCommitMessage = (
    input: CommitMessageGenerationInput,
  ): Effect.Effect<CommitMessageGenerationResult, TextGenerationError> =>
    Effect.gen(function* () {
      const branchLine = input.includeBranch
        ? ' Also return "branch": a short kebab-case branch name for this change.'
        : "";
      const parsed = yield* runJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        prompt: [
          "Write a git commit message for the staged change below.",
          `Reply with ONLY a JSON object: {"subject": string, "body": string}.${branchLine}`,
          "The subject is one imperative line under 72 characters and has no trailing period.",
          "The body explains why the change was made; use an empty string if there is nothing to add.",
          input.branch ? `Current branch: ${input.branch}` : "",
          `Staged summary:\n${clip(input.stagedSummary, 4_000)}`,
          `Staged patch:\n${clip(input.stagedPatch)}`,
        ]
          .filter((part) => part.length > 0)
          .join("\n\n"),
      });

      const subject = readString(parsed, "subject");
      if (!subject) {
        return yield* new TextGenerationError({
          operation: "generateCommitMessage",
          detail: "Kiro CLI returned no commit subject.",
        });
      }
      const branch = readString(parsed, "branch");
      return {
        subject,
        body: readString(parsed, "body") ?? "",
        ...(input.includeBranch && branch ? { branch } : {}),
      };
    });

  const generatePrContent = (
    input: PrContentGenerationInput,
  ): Effect.Effect<PrContentGenerationResult, TextGenerationError> =>
    Effect.gen(function* () {
      const parsed = yield* runJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        prompt: [
          `Write a pull request title and body for merging ${input.headBranch} into ${input.baseBranch}.`,
          'Reply with ONLY a JSON object: {"title": string, "body": string}.',
          "The title is one line under 70 characters. The body is markdown describing what changed and why.",
          input.changeRequestTemplate
            ? `Follow this template for the body:\n${clip(input.changeRequestTemplate, 4_000)}`
            : "",
          `Commits:\n${clip(input.commitSummary, 4_000)}`,
          `Diff summary:\n${clip(input.diffSummary, 4_000)}`,
          `Diff:\n${clip(input.diffPatch)}`,
        ]
          .filter((part) => part.length > 0)
          .join("\n\n"),
      });

      const title = readString(parsed, "title");
      if (!title) {
        return yield* new TextGenerationError({
          operation: "generatePrContent",
          detail: "Kiro CLI returned no pull request title.",
        });
      }
      return { title, body: readString(parsed, "body") ?? "" };
    });

  const generateBranchName = (
    input: BranchNameGenerationInput,
  ): Effect.Effect<BranchNameGenerationResult, TextGenerationError> =>
    Effect.gen(function* () {
      const parsed = yield* runJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        prompt: [
          "Suggest a git branch name for the task below.",
          'Reply with ONLY a JSON object: {"branch": string}.',
          "Use lowercase kebab-case, at most 40 characters, no leading prefix such as feat/.",
          `Task:\n${clip(input.message, 4_000)}`,
        ].join("\n\n"),
      });

      const branch = readString(parsed, "branch");
      if (!branch) {
        return yield* new TextGenerationError({
          operation: "generateBranchName",
          detail: "Kiro CLI returned no branch name.",
        });
      }
      return { branch };
    });

  const generateThreadTitle = (
    input: ThreadTitleGenerationInput,
  ): Effect.Effect<ThreadTitleGenerationResult, TextGenerationError> =>
    Effect.gen(function* () {
      const parsed = yield* runJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        prompt: [
          "Write a short title for the conversation that starts with the message below.",
          'Reply with ONLY a JSON object: {"title": string}.',
          "At most 6 words, no trailing punctuation, no surrounding quotes.",
          input.previousTitle ? `The current title is "${input.previousTitle}"; improve it.` : "",
          input.linkedContext ? `Related context:\n${clip(input.linkedContext, 2_000)}` : "",
          `Message:\n${clip(input.message, 4_000)}`,
        ]
          .filter((part) => part.length > 0)
          .join("\n\n"),
      });

      const title = readString(parsed, "title");
      if (!title) {
        return yield* new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "Kiro CLI returned no title.",
        });
      }
      return { title };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  };
});
