// @effect-diagnostics nodeBuiltinImport:off - the symlink test exercises a real filesystem boundary.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFSP from "node:fs/promises";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverClaudeSkills } from "./Drivers/ClaudeSkills.ts";
import { deleteSkill, readSkill, upsertSkill } from "./skillFiles.ts";

const INSTANCE_ID = "claude-default";

const makeHome = Effect.fn("makeHome")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-skill-files-" });
  return { home, homePath: path.join(home, ".claude") };
});

it.layer(NodeServices.layer)("skillFiles", (it) => {
  it.effect("upsert writes SKILL.md with frontmatter and body", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { homePath } = yield* makeHome();

      const written = yield* upsertSkill({
        instanceId: INSTANCE_ID,
        homePath,
        name: "review-diff",
        description: "Review the current diff.",
        body: "# Steps\n\n1. Read the diff.\n",
      });

      const filePath = path.join(homePath, "skills", "review-diff", "SKILL.md");
      assert.equal(written.path, filePath);
      const contents = yield* fileSystem.readFileString(filePath);
      assert.equal(
        contents,
        "---\nname: review-diff\ndescription: Review the current diff.\n---\n\n# Steps\n\n1. Read the diff.\n",
      );
    }),
  );

  it.effect("read splits frontmatter description from the body", () =>
    Effect.gen(function* () {
      const { homePath } = yield* makeHome();
      yield* upsertSkill({
        instanceId: INSTANCE_ID,
        homePath,
        name: "review-diff",
        description: "Review the current diff.",
        body: "Body first line.\n\nSecond paragraph.\n",
      });

      const document = yield* readSkill({
        instanceId: INSTANCE_ID,
        homePath,
        name: "review-diff",
      });
      assert.equal(document.name, "review-diff");
      assert.equal(document.description, "Review the current diff.");
      assert.equal(document.body, "Body first line.\n\nSecond paragraph.\n");
    }),
  );

  it.effect("upsert with previousName renames by removing the old directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { homePath } = yield* makeHome();
      yield* upsertSkill({
        instanceId: INSTANCE_ID,
        homePath,
        name: "old-name",
        description: undefined,
        body: "old body\n",
      });

      yield* upsertSkill({
        instanceId: INSTANCE_ID,
        homePath,
        name: "new-name",
        description: "Renamed.",
        body: "new body\n",
        previousName: "old-name",
      });

      assert.isFalse(yield* fileSystem.exists(path.join(homePath, "skills", "old-name")));
      assert.isTrue(
        yield* fileSystem.exists(path.join(homePath, "skills", "new-name", "SKILL.md")),
      );
    }),
  );

  it.effect("rejects names that could escape the skills root", () =>
    Effect.gen(function* () {
      const { homePath } = yield* makeHome();
      const exit = yield* Effect.exit(
        upsertSkill({
          instanceId: INSTANCE_ID,
          homePath,
          name: "../escape",
          description: undefined,
          body: "nope\n",
        }),
      );
      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Failure") {
        assert.match(String(exit.cause), /Invalid skill name/);
      }
      for (const bad of ["UPPER", "has space", "a/b", "-leading-dash"]) {
        const badExit = yield* Effect.exit(
          deleteSkill({ instanceId: INSTANCE_ID, homePath, name: bad }),
        );
        assert.isTrue(badExit._tag === "Failure", `expected ${bad} to fail`);
      }
    }),
  );

  it.effect("delete removes the directory and reports missing skills", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { homePath } = yield* makeHome();
      yield* upsertSkill({
        instanceId: INSTANCE_ID,
        homePath,
        name: "doomed",
        description: undefined,
        body: "bye\n",
      });

      assert.deepEqual(yield* deleteSkill({ instanceId: INSTANCE_ID, homePath, name: "doomed" }), {
        deleted: true,
      });
      assert.isFalse(yield* fileSystem.exists(path.join(homePath, "skills", "doomed")));
      assert.deepEqual(yield* deleteSkill({ instanceId: INSTANCE_ID, homePath, name: "doomed" }), {
        deleted: false,
      });
    }),
  );

  it.effect("read fails with a typed error for a missing skill", () =>
    Effect.gen(function* () {
      const { homePath } = yield* makeHome();
      const exit = yield* Effect.exit(
        readSkill({ instanceId: INSTANCE_ID, homePath, name: "missing" }),
      );
      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Failure") {
        assert.match(String(exit.cause), /ServerSkillFileError/);
        assert.match(String(exit.cause), /was not found on disk/);
      }
    }),
  );

  it.effect("collapses multi-line descriptions into one frontmatter line", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { homePath } = yield* makeHome();
      yield* upsertSkill({
        instanceId: INSTANCE_ID,
        homePath,
        name: "wrapped",
        description: "line one\nline two",
        body: "body\n",
      });
      const contents = yield* fileSystem.readFileString(
        path.join(homePath, "skills", "wrapped", "SKILL.md"),
      );
      assert.include(contents, "description: line one line two\n");
    }),
  );

  it.effect("updates preserve frontmatter, attachments and a full backup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { homePath } = yield* makeHome();
      const directory = path.join(homePath, "skills", "existing");
      yield* fs.makeDirectory(directory, { recursive: true });
      const original =
        "---\nname: existing\ndescription: 'old: value'\nuser-invocable: false\n---\n\nOld instructions.\n";
      yield* fs.writeFileString(path.join(directory, "SKILL.md"), original);
      yield* fs.writeFileString(path.join(directory, "helper.sh"), "keep this script\n");

      yield* upsertSkill({
        instanceId: INSTANCE_ID,
        homePath,
        name: "existing",
        previousName: "existing",
        description: "new: value",
        body: "New instructions.\n",
      });
      const updated = yield* fs.readFileString(path.join(directory, "SKILL.md"));
      assert.include(updated, "user-invocable: false");
      assert.equal(
        (yield* readSkill({ instanceId: INSTANCE_ID, homePath, name: "existing" })).description,
        "new: value",
      );
      assert.equal(
        yield* fs.readFileString(path.join(directory, "helper.sh")),
        "keep this script\n",
      );
      const backupRoot = path.join(homePath, ".t3-skill-backups");
      const [backup] = yield* fs.readDirectory(backupRoot);
      assert.isDefined(backup);
      assert.equal(
        yield* fs.readFileString(path.join(backupRoot, backup!, "existing", "SKILL.md")),
        original,
      );
      assert.equal(
        yield* fs.readFileString(path.join(backupRoot, backup!, "existing", "helper.sh")),
        "keep this script\n",
      );
    }),
  );

  it.effect("refuses creation collisions and rename collisions without changing either skill", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { homePath } = yield* makeHome();
      for (const name of ["first", "second"]) {
        yield* upsertSkill({
          instanceId: INSTANCE_ID,
          homePath,
          name,
          description: undefined,
          body: `${name}\n`,
        });
      }
      for (const previousName of [undefined, "first"]) {
        const result = yield* Effect.exit(
          upsertSkill({
            instanceId: INSTANCE_ID,
            homePath,
            name: "second",
            previousName,
            description: undefined,
            body: "overwritten\n",
          }),
        );
        assert.equal(result._tag, "Failure");
      }
      for (const name of ["first", "second"]) {
        assert.include(
          yield* fs.readFileString(path.join(homePath, "skills", name, "SKILL.md")),
          `${name}\n`,
        );
      }
    }),
  );

  it.effect("discovery sees creation, rename and deletion from the same Claude home", () =>
    Effect.gen(function* () {
      const { homePath } = yield* makeHome();
      yield* upsertSkill({
        instanceId: INSTANCE_ID,
        homePath,
        name: "draft",
        description: "Review: carefully",
        body: "# Check\n",
      });
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath })).map((skill) => skill.name),
        ["draft"],
      );
      yield* upsertSkill({
        instanceId: INSTANCE_ID,
        homePath,
        name: "published",
        previousName: "draft",
        description: "Review: carefully",
        body: "# Publish\n",
      });
      const renamed = yield* discoverClaudeSkills({ homePath });
      assert.deepEqual(
        renamed.map((skill) => skill.name),
        ["published"],
      );
      assert.equal(renamed[0]?.description, "Review: carefully");
      yield* deleteSkill({ instanceId: INSTANCE_ID, homePath, name: "published" });
      assert.deepEqual(yield* discoverClaudeSkills({ homePath }), []);
    }),
  );

  it.effect("writes, reads and deletes in the effective Claude config directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home } = yield* makeHome();
      const configDir = path.join(home, "custom-claude");
      const environment = { CLAUDE_CONFIG_DIR: configDir };
      const input = { instanceId: INSTANCE_ID, homePath: "", environment, name: "custom-home" };
      yield* upsertSkill({ ...input, description: "From custom config", body: "Instructions.\n" });
      assert.isTrue(yield* fs.exists(path.join(configDir, "skills", "custom-home", "SKILL.md")));
      assert.equal((yield* readSkill(input)).body, "Instructions.\n");
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: "" }, undefined, environment)).map(
          (skill) => skill.name,
        ),
        ["custom-home"],
      );
      assert.deepEqual(yield* deleteSkill(input), { deleted: true });
      assert.deepEqual(yield* discoverClaudeSkills({ homePath: "" }, undefined, environment), []);
    }),
  );

  it.effect("deleting archives the entire skill without following a symlink", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { homePath } = yield* makeHome();
      yield* upsertSkill({
        instanceId: INSTANCE_ID,
        homePath,
        name: "archived",
        description: undefined,
        body: "instructions\n",
      });
      yield* fs.writeFileString(
        path.join(homePath, "skills", "archived", "reference.md"),
        "attachment\n",
      );
      yield* deleteSkill({ instanceId: INSTANCE_ID, homePath, name: "archived" });
      const backupRoot = path.join(homePath, ".t3-skill-backups");
      const [backup] = yield* fs.readDirectory(backupRoot);
      assert.equal(
        yield* fs.readFileString(path.join(backupRoot, backup!, "archived", "reference.md")),
        "attachment\n",
      );
      assert.isFalse(yield* fs.exists(path.join(homePath, "skills", "archived")));

      const outside = path.join(homePath, "outside");
      yield* fs.makeDirectory(outside);
      yield* fs.writeFileString(path.join(outside, "SKILL.md"), "safe\n");
      yield* Effect.promise(() =>
        NodeFSP.symlink(outside, path.join(homePath, "skills", "linked")),
      );
      assert.equal(
        (yield* Effect.exit(deleteSkill({ instanceId: INSTANCE_ID, homePath, name: "linked" })))
          ._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.exit(
          upsertSkill({
            instanceId: INSTANCE_ID,
            homePath,
            name: "linked",
            description: undefined,
            body: "evil\n",
          }),
        ))._tag,
        "Failure",
      );
      assert.equal(yield* fs.readFileString(path.join(outside, "SKILL.md")), "safe\n");
    }),
  );
});
