/**
 * Claude skill file editing on the upstream base.
 *
 * Same behavior the V1 fork shipped for the `server.skill*` RPCs: read,
 * upsert (with rename), and delete of `SKILL.md` files under
 * `<claude configDir>/skills/<name>/`, with a backup before any destructive
 * change. Upstream can only *discover* skills; this module adds the write
 * path, so it carries its own copies of the frontmatter pattern and the
 * config-dir resolution to avoid reaching into upstream's file internals.
 *
 * @module fork/skills/skillFiles
 */
// @effect-diagnostics nodeBuiltinImport:off - FileSystem has no no-follow stat or copy API.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { isMap, parseDocument } from "yaml";

export interface SkillFileErrorInput {
  readonly operation: "read" | "upsert" | "delete";
  readonly instanceId: string;
  readonly skillName: string;
  readonly reason: string;
  readonly cause?: unknown;
}

/**
 * Skill file failure. A `Schema.TaggedError` so the RPC layer serializes it
 * into the contract's `ServerSkillFileError` member without a mapper.
 */
export class SkillFileError extends Schema.TaggedError<SkillFileError>()("ServerSkillFileError", {
  operation: Schema.Literals(["read", "upsert", "delete"]),
  instanceId: Schema.String.pipe(Schema.brand("ProviderInstanceId")),
  skillName: Schema.String,
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  static from(input: SkillFileErrorInput): SkillFileError {
    return new SkillFileError({
      operation: input.operation,
      instanceId: input.instanceId as never,
      skillName: input.skillName,
      reason: input.reason,
      ...(input.cause !== undefined ? { cause: input.cause as never } : {}),
    });
  }

  override get message(): string {
    return `Skill ${this.operation} failed for ${this.skillName}: ${this.reason}`;
  }
}

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillOperation = "read" | "upsert" | "delete";

export interface SkillDocument {
  readonly name: string;
  readonly description: string | undefined;
  readonly body: string;
  readonly path: string;
}

const skillError = (input: SkillFileErrorInput) => SkillFileError.from(input);

type SkillContext = {
  readonly operation: SkillOperation;
  readonly instanceId: string;
  readonly skillName: string;
};

const fileError = (context: SkillContext, reason: string, cause?: unknown) =>
  skillError({ ...context, reason, ...(cause !== undefined ? { cause } : {}) });

const checkName = (name: string, context: SkillContext) => {
  if (!SKILL_NAME_PATTERN.test(name)) {
    return fileError(context, "Invalid skill name. Use lowercase letters, digits and dashes.");
  }
  return undefined;
};

const isMissing = (error: unknown): boolean =>
  error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";

const inspect = (target: string, context: SkillContext) =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await NodeFSP.lstat(target);
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },
    catch: (cause) => fileError(context, `Could not inspect ${target}.`, cause),
  });

const assertDirectory = Effect.fn("skillFiles.assertDirectory")(function* (
  target: string,
  context: SkillContext,
  create: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  let info = yield* inspect(target, context);
  if (!info && create) {
    yield* fs
      .makeDirectory(target, { recursive: true })
      .pipe(Effect.mapError((cause) => fileError(context, `Could not create ${target}.`, cause)));
    info = yield* inspect(target, context);
  }
  if (info && (!info.isDirectory() || info.isSymbolicLink())) {
    return yield* fileError(context, `Refusing non-directory or symbolic link at ${target}.`);
  }
  return info !== undefined;
});

const resolveLocations = Effect.fn("skillFiles.resolveLocations")(function* (
  homePath: string,
  environment: NodeJS.ProcessEnv,
  context: SkillContext,
) {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const envConfig = environment.CLAUDE_CONFIG_DIR?.trim();
  if (!homePath.trim() && envConfig && !NodePath.isAbsolute(envConfig)) {
    return yield* fileError(
      context,
      "Relative CLAUDE_CONFIG_DIR depends on the project; set an absolute Claude home path for this instance.",
    );
  }
  const trimmedHome = homePath.trim();
  if (trimmedHome.length > 0) {
    const configDir = path.resolve(expandHomePath(trimmedHome, home));
    return {
      configDir,
      skillsRoot: path.join(configDir, "skills"),
      backupRoot: path.join(configDir, ".t3-skill-backups"),
      path,
    };
  }
  if (envConfig) {
    const configDir = path.resolve(envConfig);
    return {
      configDir,
      skillsRoot: path.join(configDir, "skills"),
      backupRoot: path.join(configDir, ".t3-skill-backups"),
      path,
    };
  }
  const configDir = path.join(home, ".claude");
  return {
    configDir,
    skillsRoot: path.join(configDir, "skills"),
    backupRoot: path.join(configDir, ".t3-skill-backups"),
    path,
  };
});

const skillPaths = (root: string, name: string, path: Path.Path) => ({
  directory: path.join(root, name),
  filePath: path.join(root, name, "SKILL.md"),
});

const assertSkillFile = Effect.fn("skillFiles.assertSkillFile")(function* (
  filePath: string,
  context: SkillContext,
) {
  const info = yield* inspect(filePath, context);
  if (info && (!info.isFile() || info.isSymbolicLink())) {
    return yield* fileError(context, `Refusing non-file or symbolic link at ${filePath}.`);
  }
  return info !== undefined;
});

function parseSkill(contents: string) {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return { description: undefined, body: contents };
  const yaml = parseDocument(match[1] ?? "");
  if (yaml.errors.length > 0 || (yaml.contents !== null && !isMap(yaml.contents))) {
    throw new Error("Malformed SKILL.md frontmatter.");
  }
  const value = yaml.get("description");
  const description = typeof value === "string" ? value.trim() : undefined;
  return {
    description: description || undefined,
    body: contents.slice(match[0].length).replace(/^\r?\n/, ""),
  };
}

function renderSkill(
  contents: string | undefined,
  input: { name: string; description?: string | undefined; body: string },
) {
  const match = contents ? FRONTMATTER_PATTERN.exec(contents) : null;
  const yaml = parseDocument(match?.[1] ?? "");
  if (yaml.errors.length > 0 || (yaml.contents !== null && !isMap(yaml.contents))) {
    throw new Error("Malformed SKILL.md frontmatter; edit this file on disk instead.");
  }
  yaml.set("name", input.name);
  if (input.description?.trim())
    yaml.set("description", input.description.trim().replace(/\s*\r?\n\s*/g, " "));
  else yaml.delete("description");
  const body = input.body.endsWith("\n") ? input.body : `${input.body}\n`;
  return `---\n${yaml.toString()}---\n\n${body}`;
}

const makeBackup = Effect.fn("skillFiles.makeBackup")(function* (
  backupRoot: string,
  source: string,
  context: SkillContext,
  move: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* assertDirectory(backupRoot, context, true);
  const backup = yield* fs
    .makeTempDirectory({ directory: backupRoot, prefix: `${context.skillName}-` })
    .pipe(
      Effect.mapError((cause) => fileError(context, "Could not allocate a skill backup.", cause)),
    );
  const destination = NodePath.join(backup, context.skillName);
  if (move) {
    yield* fs
      .rename(source, destination)
      .pipe(Effect.mapError((cause) => fileError(context, `Could not archive ${source}.`, cause)));
  } else {
    yield* Effect.tryPromise({
      try: () =>
        NodeFSP.cp(source, destination, {
          recursive: true,
          dereference: false,
          errorOnExist: true,
          force: false,
        }),
      catch: (cause) => fileError(context, `Could not back up ${source}.`, cause),
    });
  }
  return destination;
});

export const readSkill = Effect.fn("skillFiles.readSkill")(function* (input: {
  readonly instanceId: string;
  readonly homePath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly name: string;
}) {
  const context = {
    operation: "read" as const,
    instanceId: input.instanceId,
    skillName: input.name,
  };
  const invalid = checkName(input.name, context);
  if (invalid) return yield* invalid;
  const fs = yield* FileSystem.FileSystem;
  const { skillsRoot, path } = yield* resolveLocations(
    input.homePath,
    input.environment ?? process.env,
    context,
  );
  yield* assertDirectory(skillsRoot, context, false);
  const { directory, filePath } = skillPaths(skillsRoot, input.name, path);
  yield* assertDirectory(directory, context, false);
  const present = yield* assertSkillFile(filePath, context);
  if (!present)
    return yield* fileError(
      context,
      `Skill "${input.name}" was not found on disk (expected ${filePath}).`,
    );
  const contents = yield* fs
    .readFileString(filePath)
    .pipe(Effect.mapError((cause) => fileError(context, `Could not read ${filePath}.`, cause)));
  const parsed = yield* Effect.try({
    try: () => parseSkill(contents),
    catch: (cause) => fileError(context, `Could not parse ${filePath}.`, cause),
  });
  return { name: input.name, ...parsed, path: filePath } satisfies SkillDocument;
});

export const upsertSkill = Effect.fn("skillFiles.upsertSkill")(function* (input: {
  readonly instanceId: string;
  readonly homePath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly name: string;
  readonly description: string | undefined;
  readonly body: string;
  readonly previousName?: string | undefined;
}) {
  const context = {
    operation: "upsert" as const,
    instanceId: input.instanceId,
    skillName: input.name,
  };
  const invalid = checkName(input.name, context);
  if (invalid) return yield* invalid;
  if (input.previousName) {
    const invalidPrevious = checkName(input.previousName, {
      ...context,
      skillName: input.previousName,
    });
    if (invalidPrevious) return yield* invalidPrevious;
  }
  if (!input.body.trim()) return yield* fileError(context, "Skill instructions cannot be empty.");
  const fs = yield* FileSystem.FileSystem;
  const { skillsRoot, backupRoot, path } = yield* resolveLocations(
    input.homePath,
    input.environment ?? process.env,
    context,
  );
  yield* assertDirectory(skillsRoot, context, true);
  const current = skillPaths(skillsRoot, input.name, path);
  const previous = input.previousName
    ? skillPaths(skillsRoot, input.previousName, path)
    : undefined;
  const renaming = previous !== undefined && previous.directory !== current.directory;
  const source = previous ?? current;
  const sourceExists = yield* assertDirectory(source.directory, context, false);
  if (previous && !sourceExists)
    return yield* fileError(
      context,
      `Skill "${input.previousName}" no longer exists. Reload before saving.`,
    );
  if (sourceExists && !(yield* assertSkillFile(source.filePath, context))) {
    return yield* fileError(context, `Missing SKILL.md in ${source.directory}.`);
  }
  if (!previous && sourceExists)
    return yield* fileError(
      context,
      `Skill "${input.name}" already exists. Open it for editing instead.`,
    );
  if (renaming && (yield* inspect(current.directory, context))) {
    return yield* fileError(context, `Skill "${input.name}" already exists. Choose another name.`);
  }
  const original = sourceExists
    ? yield* fs
        .readFileString(source.filePath)
        .pipe(
          Effect.mapError((cause) =>
            fileError(context, `Could not read ${source.filePath}.`, cause),
          ),
        )
    : undefined;
  const contents = yield* Effect.try({
    try: () =>
      renderSkill(original, { name: input.name, description: input.description, body: input.body }),
    catch: (cause) => fileError(context, "Could not serialize SKILL.md.", cause),
  });
  // Keep a full copy before changing any existing skill, including references and scripts.
  if (sourceExists) yield* makeBackup(backupRoot, source.directory, context, false);
  if (renaming) {
    yield* fs
      .rename(source.directory, current.directory)
      .pipe(
        Effect.mapError((cause) =>
          fileError(context, `Could not rename ${source.directory}.`, cause),
        ),
      );
  }
  yield* writeFileStringAtomically({ filePath: current.filePath, contents }).pipe(
    Effect.mapError((cause) =>
      fileError(context, `Could not write ${current.filePath}; a backup was preserved.`, cause),
    ),
    Effect.catch((error) =>
      renaming
        ? fs.rename(current.directory, source.directory).pipe(
            Effect.mapError((cause) =>
              fileError(
                context,
                `Could not restore ${source.directory}; a backup was preserved.`,
                cause,
              ),
            ),
            Effect.andThen(Effect.fail(error)),
          )
        : Effect.fail(error),
    ),
  );
  return {
    name: input.name,
    description: input.description?.trim() || undefined,
    body: input.body,
    path: current.filePath,
  } satisfies SkillDocument;
});

export const deleteSkill = Effect.fn("skillFiles.deleteSkill")(function* (input: {
  readonly instanceId: string;
  readonly homePath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly name: string;
}) {
  const context = {
    operation: "delete" as const,
    instanceId: input.instanceId,
    skillName: input.name,
  };
  const invalid = checkName(input.name, context);
  if (invalid) return yield* invalid;
  const { skillsRoot, backupRoot, path } = yield* resolveLocations(
    input.homePath,
    input.environment ?? process.env,
    context,
  );
  yield* assertDirectory(skillsRoot, context, false);
  const { directory, filePath } = skillPaths(skillsRoot, input.name, path);
  if (!(yield* assertDirectory(directory, context, false))) return { deleted: false };
  if (!(yield* assertSkillFile(filePath, context)))
    return yield* fileError(context, `Missing SKILL.md in ${directory}.`);
  // Move, rather than recursively delete: attachments stay recoverable with the skill.
  yield* makeBackup(backupRoot, directory, context, true);
  return { deleted: true };
});
