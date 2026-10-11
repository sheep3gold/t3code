import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const COMPLETED_AT = "2026-01-01T00:05:00.000Z";
const LATER_COMPLETED_AT = "2026-01-01T00:09:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

function makeReadModel(overrides: Partial<OrchestrationThread> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        pullRequests: [],
        branch: null,
        worktreePath: null,
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "completed",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: COMPLETED_AT,
          assistantMessageId: null,
        },
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        activeOrderKey: null,
        lastReadAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
        ...overrides,
      },
    ],
    updatedAt: NOW,
  };
}

const decideAndProject = Effect.fn(function* (
  readModel: OrchestrationReadModel,
  command: Parameters<typeof decideOrchestrationCommand>[0]["command"],
) {
  const decided = yield* decideOrchestrationCommand({ command, readModel });
  const events = Array.isArray(decided) ? decided : [decided];
  expect(events).toHaveLength(1);
  let next = readModel;
  for (const event of events) {
    next = yield* projectEvent(next, { ...event, sequence: next.snapshotSequence + 1 });
  }
  return { event: events[0]!, readModel: next };
});

const readCommand = (readAt: string) =>
  ({
    type: "thread.read.mark",
    commandId: CommandId.make(`cmd-read-${readAt}`),
    threadId: THREAD_ID,
    readAt,
  }) as const;

it.layer(NodeServices.layer)("thread read state", (it) => {
  it.effect("records a read without touching thread activity timestamps", () =>
    Effect.gen(function* () {
      const { event, readModel } = yield* decideAndProject(
        makeReadModel(),
        readCommand(COMPLETED_AT),
      );
      expect(event).toMatchObject({
        type: "thread.meta-updated",
        payload: { threadId: THREAD_ID, lastReadAt: COMPLETED_AT, updatedAt: NOW },
      });
      expect(readModel.threads[0]).toMatchObject({ lastReadAt: COMPLETED_AT, updatedAt: NOW });
    }),
  );

  it.effect("never rewinds a newer read recorded by another device", () =>
    Effect.gen(function* () {
      const { readModel } = yield* decideAndProject(
        makeReadModel({ lastReadAt: LATER_COMPLETED_AT }),
        readCommand(COMPLETED_AT),
      );
      expect(readModel.threads[0]?.lastReadAt).toBe(LATER_COMPLETED_AT);
    }),
  );

  it.effect("advances past an older read", () =>
    Effect.gen(function* () {
      const { readModel } = yield* decideAndProject(
        makeReadModel({ lastReadAt: COMPLETED_AT }),
        readCommand(LATER_COMPLETED_AT),
      );
      expect(readModel.threads[0]?.lastReadAt).toBe(LATER_COMPLETED_AT);
    }),
  );

  it.effect("mark unread rewinds to just before the latest completion", () =>
    Effect.gen(function* () {
      const { readModel } = yield* decideAndProject(
        makeReadModel({ lastReadAt: LATER_COMPLETED_AT }),
        {
          type: "thread.unread.mark",
          commandId: CommandId.make("cmd-unread"),
          threadId: THREAD_ID,
        },
      );
      expect(readModel.threads[0]).toMatchObject({
        lastReadAt: "2026-01-01T00:04:59.999Z",
        updatedAt: NOW,
      });
    }),
  );

  it.effect("mark unread without a completion keeps the existing read", () =>
    Effect.gen(function* () {
      const { readModel } = yield* decideAndProject(
        makeReadModel({ latestTurn: null, lastReadAt: COMPLETED_AT }),
        {
          type: "thread.unread.mark",
          commandId: CommandId.make("cmd-unread"),
          threadId: THREAD_ID,
        },
      );
      expect(readModel.threads[0]?.lastReadAt).toBe(COMPLETED_AT);
    }),
  );

  it.effect("rejects marking an unknown thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: { ...readCommand(COMPLETED_AT), threadId: ThreadId.make("missing") },
        readModel: makeReadModel(),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
