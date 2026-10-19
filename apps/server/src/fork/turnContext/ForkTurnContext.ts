import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadLedger from "../ledger/ThreadLedgerToolkit.ts";
import * as ThreadLedgerPersistence from "../ledger/ThreadLedger.ts";
import { readAgentLessonContext } from "../memory/AgentMemory.ts";
import * as AgentMemories from "../memory/AgentMemories.ts";
import * as MemsearchMirror from "../memory/MemsearchMirror.ts";

export interface ForkTurnContextInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly userText: string;
}

/**
 * Durable notes the fork prepends to every provider turn: saved lessons,
 * memory-api facts relevant to the request, and the thread's work ledger. It
 * never fails a turn; a source that cannot be read contributes nothing.
 */
export class ForkTurnContext extends Context.Service<
  ForkTurnContext,
  { readonly read: (input: ForkTurnContextInput) => Effect.Effect<string> }
>()("t3/fork/turnContext/ForkTurnContext") {}

const orEmpty =
  (source: string, input: ForkTurnContextInput) =>
  <E>(effect: Effect.Effect<string, E>): Effect.Effect<string> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`provider turn could not read ${source}`, {
          threadId: input.threadId,
          projectId: input.projectId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as("")),
      ),
    );

export const layer = Layer.effect(
  ForkTurnContext,
  Effect.gen(function* () {
    const memories = yield* AgentMemories.AgentMemoryRepository;
    const ledger = yield* ThreadLedgerPersistence.ThreadLedgerRepository;
    return {
      read: (input) =>
        Effect.all(
          [
            readAgentLessonContext(input.projectId).pipe(
              Effect.provideService(AgentMemories.AgentMemoryRepository, memories),
              orEmpty("saved lessons", input),
            ),
            ThreadLedger.readThreadLedgerContext(input.threadId).pipe(
              Effect.provideService(ThreadLedgerPersistence.ThreadLedgerRepository, ledger),
              orEmpty("thread ledger", input),
            ),
            MemsearchMirror.relevantFactsContext(input.userText, input.projectId),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.map((parts) => parts.filter((part) => part !== "").join("\n\n"))),
    };
  }),
);
