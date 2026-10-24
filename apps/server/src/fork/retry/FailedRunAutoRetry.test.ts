import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  autoRetryCommand,
  isTransientFailure,
  MAX_AUTO_RETRY_ATTEMPTS,
  retryDelayMs,
} from "./FailedRunAutoRetry.ts";

type Projection = Parameters<typeof autoRetryCommand>[0];

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 20, 12, minute));

const apiError: OrchestrationV2ProviderFailure = {
  class: "provider_error",
  message: "Claude gave up after repeated API errors.",
  code: "api_error",
  retryable: null,
};

function run(
  id: string,
  ordinal: number,
  status: OrchestrationV2Run["status"],
  userMessageId = `message-${id}`,
): OrchestrationV2Run {
  return {
    id,
    threadId: "thread-1",
    ordinal,
    status,
    userMessageId,
    rootNodeId: `node-${id}`,
    requestedAt: at(ordinal),
    startedAt: at(ordinal),
    completedAt: status === "running" || status === "queued" ? null : at(ordinal),
  } as unknown as OrchestrationV2Run;
}

function projection(
  runs: ReadonlyArray<OrchestrationV2Run>,
  failure: OrchestrationV2ProviderFailure | null = apiError,
  overrides: { thread?: object; runtimeRequests?: ReadonlyArray<object> } = {},
): Projection {
  const failed = runs.findLast((candidate) => candidate.status === "failed");
  const turnItems =
    failure === null || failed === undefined
      ? []
      : [
          {
            id: `error-${failed.id}`,
            type: "error",
            status: "failed",
            runId: failed.id,
            nodeId: failed.rootNodeId,
            ordinal: 1,
            updatedAt: failed.completedAt,
            failure,
          },
        ];
  return {
    thread: {
      id: "thread-1",
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      ...overrides.thread,
    },
    runs,
    turnItems,
    runtimeRequests: overrides.runtimeRequests ?? [],
  } as unknown as Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "turnItems" | "runtimeRequests"
  >;
}

describe("FailedRunAutoRetry", () => {
  it("retries only transient provider and transport failures", () => {
    expect(isTransientFailure(apiError)).toBe(true);
    expect(
      isTransientFailure({ ...apiError, class: "transport_error", code: null, message: "reset" }),
    ).toBe(true);
    expect(isTransientFailure({ ...apiError, class: "unknown", retryable: true })).toBe(true);
    // A provider error without a code is a local guard such as an oversized handoff.
    expect(isTransientFailure({ ...apiError, code: null })).toBe(false);
    expect(isTransientFailure({ ...apiError, retryable: false })).toBe(false);
    expect(isTransientFailure({ ...apiError, class: "usage_limit", retryable: true })).toBe(false);
    expect(isTransientFailure({ ...apiError, class: "permission_error" })).toBe(false);
    expect(isTransientFailure({ ...apiError, class: "validation_error" })).toBe(false);
    expect(isTransientFailure(null)).toBe(false);
  });

  it("continues the latest failed run with a deterministic first attempt", () => {
    const command = autoRetryCommand(
      projection([run("run-1", 1, "completed"), run("run-2", 2, "failed")]),
      "run-2" as OrchestrationV2Run["id"],
    );
    expect(command).toMatchObject({
      type: "message.dispatch",
      commandId: "auto-retry:1:run-2",
      messageId: "auto-retry:1:run-2",
      threadId: "thread-1",
      dispatchMode: { type: "start_immediately" },
    });
  });

  it("chains attempts to the original run and stops at the cap", () => {
    const second = autoRetryCommand(
      projection([run("run-2", 2, "failed"), run("run-3", 3, "failed", "auto-retry:1:run-2")]),
      "run-3" as OrchestrationV2Run["id"],
    );
    expect(second?.commandId).toBe("auto-retry:2:run-2");
    expect(
      autoRetryCommand(
        projection([run("run-5", 5, "failed", `auto-retry:${MAX_AUTO_RETRY_ATTEMPTS}:run-2`)]),
        "run-5" as OrchestrationV2Run["id"],
      ),
    ).toBeNull();
    expect(retryDelayMs(run("run-2", 2, "failed"))).toBeLessThan(
      retryDelayMs(run("run-3", 3, "failed", "auto-retry:2:run-2")),
    );
  });

  it("leaves the thread alone once something else happened", () => {
    const failed = run("run-2", 2, "failed");
    const id = failed.id;
    // The user already sent a newer message that finished.
    expect(autoRetryCommand(projection([failed, run("run-3", 3, "completed")]), id)).toBeNull();
    // An unheld queued message is the user's follow-up; resume it without a new prompt.
    expect(autoRetryCommand(projection([failed, run("run-3", 3, "queued")]), id)).toMatchObject({
      type: "queue.resume",
      commandId: "auto-retry:queue:run-2",
    });
    expect(
      autoRetryCommand(projection([failed, { ...run("run-3", 3, "queued"), queueHeld: true }]), id),
    ).toBeNull();
    expect(autoRetryCommand(projection([failed, run("run-3", 3, "running")]), id)).toBeNull();
    // Waiting on the user, or the thread was archived or settled.
    expect(
      autoRetryCommand(
        projection([failed], apiError, { runtimeRequests: [{ status: "pending" }] }),
        id,
      ),
    ).toBeNull();
    expect(
      autoRetryCommand(projection([failed], apiError, { thread: { archivedAt: at(9) } }), id),
    ).toBeNull();
    expect(
      autoRetryCommand(
        projection([failed], apiError, { thread: { settledOverride: "settled" } }),
        id,
      ),
    ).toBeNull();
    // A usage limit belongs to the usage-limit recovery worker.
    expect(
      autoRetryCommand(projection([failed], { ...apiError, class: "usage_limit" }), id),
    ).toBeNull();
  });
});
