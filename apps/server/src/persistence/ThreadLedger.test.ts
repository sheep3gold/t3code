import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "./Migrations.ts";
import * as ThreadLedger from "./ThreadLedger.ts";

const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });
const testLayer = Layer.mergeAll(sqlite, ThreadLedger.layer.pipe(Layer.provide(sqlite)));
const layer = it.layer(testLayer);

layer("ThreadLedgerRepository", (it) => {
  it.effect("records state and events atomically while preserving artifact pointers", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 56 });
      const repository = yield* ThreadLedger.ThreadLedgerRepository;
      const threadId = ThreadId.make("thread-ledger");
      assert.equal((yield* repository.read(threadId)).state, null);

      yield* repository.record({
        threadId,
        state: {
          goal: "Ship the feature",
          phase: "implementing",
          next: "Run the focused tests",
          artifacts: { branch: "feat/x", path: "src/main.ts" },
        },
        updatedAt: "2026-09-26T12:00:00.000Z",
        event: { kind: "phase", message: "Implementation started" },
      });
      const snapshot = yield* repository.read(threadId);
      assert.equal(snapshot.state?.phase, "implementing");
      assert.deepStrictEqual(snapshot.state?.artifacts, {
        branch: "feat/x",
        path: "src/main.ts",
      });
      assert.deepStrictEqual(
        snapshot.events.map((event) => [event.kind, event.message]),
        [["phase", "Implementation started"]],
      );
    }),
  );
});
