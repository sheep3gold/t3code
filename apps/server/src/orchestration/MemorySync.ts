import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import * as AgentMemories from "../persistence/AgentMemories.ts";
import * as MemsearchMirror from "../persistence/MemsearchMirror.ts";
import { forkParked } from "../serverActivation.ts";

/**
 * Keeps the local memory cache in step with memory-api, which owns memories.
 *
 * - pull (every 5 minutes): apply remote changes since the last cursor. This is how the
 *   nightly consolidation's merges, invalidations and new records reach T3; invalidated
 *   records are deleted from the cache so they stop being injected.
 * - backfill (at start, then hourly): push local memories memory-api has never seen —
 *   writes made while it was unreachable would otherwise stay local forever.
 */
const PULL_INTERVAL = "5 minutes";
const BACKFILL_EVERY_PULLS = 12;

export const startMemorySync = Effect.gen(function* () {
  if (!MemsearchMirror.isConfigured()) return;
  // Optional so startup compositions without memory persistence (tests) stay valid.
  const maybeRepository = yield* Effect.serviceOption(AgentMemories.AgentMemoryRepository);
  if (Option.isNone(maybeRepository)) return;
  const repository = maybeRepository.value;
  const cursor = yield* Ref.make<string | null>(null);
  const pulls = yield* Ref.make(0);

  const backfill = Effect.gen(function* () {
    const remote = yield* MemsearchMirror.listRemoteChanges(null);
    if (remote === null) return;
    const known = new Set(remote.records.map((record) => record.id));
    const local = yield* repository.listAll();
    let pushed = 0;
    for (const memory of local) {
      if (known.has(memory.id)) continue;
      if (yield* MemsearchMirror.pushNow(memory)) pushed += 1;
    }
    if (pushed > 0) yield* Effect.logInfo("memory-api backfill pushed local memories", { pushed });
  });

  const pull = Effect.gen(function* () {
    const count = yield* Ref.getAndUpdate(pulls, (n) => n + 1);
    if (count % BACKFILL_EVERY_PULLS === 0) yield* backfill;
    const changes = yield* MemsearchMirror.listRemoteChanges(yield* Ref.get(cursor));
    if (changes === null) return;
    const result = yield* repository.applyRemote(changes.records);
    if (changes.cursor) yield* Ref.set(cursor, changes.cursor);
    if (result.upserted > 0 || result.removed > 0 || result.skipped > 0) {
      yield* Effect.logInfo("memory-api pull applied", result);
    }
  });

  yield* forkParked(
    pull.pipe(
      Effect.catchCause((cause) => Effect.logWarning("memory-api sync failed", { cause })),
      Effect.repeat(Schedule.spaced(PULL_INTERVAL)),
    ),
  );
});
