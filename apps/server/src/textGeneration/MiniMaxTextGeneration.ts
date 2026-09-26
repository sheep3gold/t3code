import { TextGenerationError, type MiniMaxSettings } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { miniMaxExecModel, miniMaxProcessEnvironment } from "../provider/acp/MiniMaxAcpSupport.ts";
import { spawnAndCollect } from "../provider/providerSnapshot.ts";
import type * as TextGeneration from "./TextGeneration.ts";
type Operation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";
const TIMEOUT_MS = 90_000;
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const isTextGenerationError = Schema.is(TextGenerationError);
function parseObject(text: string): Record<string, unknown> | undefined {
  const candidates = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  if (fenced) candidates.push(fenced.trim());
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    const value = decodeJson(candidate);
    if (
      Option.isSome(value) &&
      value.value &&
      typeof value.value === "object" &&
      !Array.isArray(value.value)
    )
      return value.value as Record<string, unknown>;
  }
  return undefined;
}
function stringValue(value: Record<string, unknown>, key: string): string | undefined {
  const item = value[key];
  return typeof item === "string" && item.trim() ? item.trim() : undefined;
}
export const makeMiniMaxTextGeneration = Effect.fn("makeMiniMaxTextGeneration")(function* (
  settings: MiniMaxSettings,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = miniMaxProcessEnvironment(settings, baseEnvironment);
  const runJson = (
    operation: Operation,
    cwd: string,
    model: string,
    prompt: string,
  ): Effect.Effect<Record<string, unknown>, TextGenerationError> =>
    Effect.gen(function* () {
      const binary = settings.binaryPath?.trim() || "mcode";
      const args = [
        "exec",
        "--cwd",
        cwd,
        "--model",
        miniMaxExecModel(model),
        "--permission",
        "off",
        "--max-steps",
        "1",
        "--timeout",
        "90s",
        "--output-format",
        "text",
        prompt,
      ];
      const spawn = yield* resolveSpawnCommand(binary, args, { env: environment });
      const result = yield* spawnAndCollect(
        binary,
        ChildProcess.make(spawn.command, spawn.args, { env: environment, shell: spawn.shell, cwd }),
      );
      if (result.code !== 0)
        return yield* new TextGenerationError({
          operation,
          detail: `MiniMax Code exited with code ${result.code}.`,
        });
      const parsed = parseObject(result.stdout);
      if (!parsed)
        return yield* new TextGenerationError({
          operation,
          detail: "MiniMax Code did not return a JSON object.",
        });
      return parsed;
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.timeoutOption(TIMEOUT_MS),
      Effect.flatMap((value) =>
        Option.isSome(value)
          ? Effect.succeed(value.value)
          : Effect.fail(
              new TextGenerationError({
                operation,
                detail: `MiniMax Code did not answer within ${TIMEOUT_MS}ms.`,
              }),
            ),
      ),
      Effect.catchIf(
        (error) => !isTextGenerationError(error),
        (cause) =>
          new TextGenerationError({
            operation,
            detail: `MiniMax Code generation failed: ${String(cause)}`,
          }),
      ),
    );
  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] = (
    input,
  ) =>
    runJson(
      "generateCommitMessage",
      input.cwd,
      input.modelSelection.model,
      `Write a git commit message. Return only JSON {"subject":string,"body":string${input.includeBranch ? ',"branch":string' : ""}}.\nBranch: ${input.branch ?? ""}\nSummary:\n${input.stagedSummary.slice(0, 4000)}\nPatch:\n${input.stagedPatch.slice(0, 24000)}`,
    ).pipe(
      Effect.flatMap((x) =>
        stringValue(x, "subject")
          ? Effect.succeed({
              subject: stringValue(x, "subject")!,
              body: stringValue(x, "body") ?? "",
              ...(input.includeBranch && stringValue(x, "branch")
                ? { branch: stringValue(x, "branch")! }
                : {}),
            })
          : Effect.fail(
              new TextGenerationError({
                operation: "generateCommitMessage",
                detail: "MiniMax Code returned no commit subject.",
              }),
            ),
      ),
    );
  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] = (
    input,
  ) =>
    runJson(
      "generatePrContent",
      input.cwd,
      input.modelSelection.model,
      `Write pull request content. Return only JSON {"title":string,"body":string}.\n${input.headBranch} -> ${input.baseBranch}\nCommits:\n${input.commitSummary.slice(0, 4000)}\nDiff:\n${input.diffPatch.slice(0, 24000)}`,
    ).pipe(
      Effect.flatMap((x) =>
        stringValue(x, "title")
          ? Effect.succeed({ title: stringValue(x, "title")!, body: stringValue(x, "body") ?? "" })
          : Effect.fail(
              new TextGenerationError({
                operation: "generatePrContent",
                detail: "MiniMax Code returned no pull request title.",
              }),
            ),
      ),
    );
  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] = (
    input,
  ) =>
    runJson(
      "generateBranchName",
      input.cwd,
      input.modelSelection.model,
      `Suggest a lowercase kebab-case branch name. Return only JSON {"branch":string}.\nTask:\n${input.message.slice(0, 4000)}`,
    ).pipe(
      Effect.flatMap((x) =>
        stringValue(x, "branch")
          ? Effect.succeed({ branch: stringValue(x, "branch")! })
          : Effect.fail(
              new TextGenerationError({
                operation: "generateBranchName",
                detail: "MiniMax Code returned no branch name.",
              }),
            ),
      ),
    );
  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] = (
    input,
  ) =>
    runJson(
      "generateThreadTitle",
      input.cwd,
      input.modelSelection.model,
      `Write a concise thread title. Return only JSON {"title":string,"needsRefinement":boolean}.\n${input.linkedContext ?? ""}\nMessage:\n${input.message.slice(-8000)}`,
    ).pipe(
      Effect.flatMap((x) =>
        stringValue(x, "title")
          ? Effect.succeed({
              title: stringValue(x, "title")!,
              needsRefinement: x.needsRefinement === true,
            })
          : Effect.fail(
              new TextGenerationError({
                operation: "generateThreadTitle",
                detail: "MiniMax Code returned no thread title.",
              }),
            ),
      ),
    );
  return { generateCommitMessage, generatePrContent, generateBranchName, generateThreadTitle };
});
