import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "./Migrations.ts";
import * as Workflows from "./ThreadWorkflows.ts";

const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });
const testLayer = Layer.mergeAll(sqlite, Workflows.layer.pipe(Layer.provide(sqlite)));
const layer = it.layer(testLayer);

layer("ThreadWorkflowRepository", (it) => {
  it.effect("advances completed steps and retries a failed step with a bounded attempt", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 59 });
      const repository = yield* Workflows.ThreadWorkflowRepository;
      const threadId = ThreadId.make("thread-workflow");
      let workflow = yield* repository.create({
        id: "workflow-1",
        threadId,
        name: "Ship",
        steps: [
          { title: "Implement", prompt: "Implement it" },
          { title: "Validate", prompt: "Run tests" },
        ],
        createdAt: "2026-09-26T12:00:00.000Z",
      });
      assert.equal(yield* repository.markRunning(workflow, "2026-09-26T12:01:00.000Z"), true);
      workflow = Option.getOrThrow(
        yield* repository.completeCurrent(
          workflow.id,
          threadId,
          "Implemented",
          "2026-09-26T12:02:00.000Z",
        ),
      );
      assert.equal(workflow.currentStep, 1);
      assert.equal(workflow.steps[0]?.status, "completed");
      assert.equal(yield* repository.markRunning(workflow, "2026-09-26T12:03:00.000Z"), true);
      workflow = Option.getOrThrow(
        yield* repository.failCurrent(
          workflow.id,
          threadId,
          "Tests failed",
          "2026-09-26T12:04:00.000Z",
        ),
      );
      assert.equal(workflow.status, "failed");
      workflow = Option.getOrThrow(
        yield* repository.retryCurrent(
          workflow.id,
          threadId,
          "2026-09-26T12:05:00.000Z",
          3,
        ),
      );
      assert.equal(workflow.status, "running");
      assert.equal(workflow.steps[1]?.status, "pending");
      assert.equal(workflow.steps[1]?.attempt, 2);
    }),
  );
});
