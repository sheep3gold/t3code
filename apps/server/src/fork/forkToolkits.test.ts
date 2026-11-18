import { describe, expect, it } from "vite-plus/test";
import { McpSchema } from "effect/ai";
import * as Context from "effect/Context";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { ArtifactToolkit } from "./artifacts/ArtifactToolkit.ts";
import { ThreadLedgerToolkit } from "./ledger/ThreadLedgerToolkit.ts";
import { AgentMemoryToolkit } from "./memory/AgentMemory.ts";
import { AgentNotificationToolkit } from "./notifications/AgentNotification.ts";
import { ThreadScheduleToolkit } from "./schedules/ThreadScheduleToolkit.ts";
import { ThreadWorkflowToolkit } from "./workflows/ThreadWorkflowToolkit.ts";

const forkToolkits = {
  artifact: ArtifactToolkit,
  ledger: ThreadLedgerToolkit,
  memory: AgentMemoryToolkit,
  notification: AgentNotificationToolkit,
  schedule: ThreadScheduleToolkit,
  workflow: ThreadWorkflowToolkit,
};

describe("fork MCP toolkits", () => {
  it("hides every tool from outside clients", () => {
    const offered = Object.entries(forkToolkits).flatMap(([toolkitName, toolkit]) =>
      Object.entries(toolkit.tools)
        .filter(
          ([, tool]) =>
            Context.getOrUndefined(tool.annotations, McpSchema.EnabledWhen) !==
            McpInvocationContext.hiddenFromOutsideClients,
        )
        .map(([toolName]) => `${toolkitName}.${toolName}`),
    );
    expect(offered).toEqual([]);
  });
});
