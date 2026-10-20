/**
 * Every fork-only service enters the upstream server through the layers
 * here, so an upstream merge touches a handful of one-line hooks:
 *   persistence/Sqlite.ts           fork migrations
 *   server.ts                       layerForkRepositories, layerForkRuntime, layerForkBackground
 *   mcp/McpHttpServer.ts            fork toolkit registrations
 *   orchestration-v2/ProviderTurnStartService.ts  ForkTurnContext
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ArtifactRepository from "./artifacts/Artifacts.ts";
import * as ThreadScheduleRepository from "./schedules/ThreadSchedules.ts";
import * as ThreadWorkflowRepository from "./workflows/ThreadWorkflows.ts";
import * as ThreadLedgerRepository from "./ledger/ThreadLedger.ts";
import * as AgentMemories from "./memory/AgentMemories.ts";
import { startMemorySync } from "./memory/MemorySync.ts";
import { startMsgHubNotifications } from "./notifications/MsgHubNotificationReactor.ts";
import { startFailedRunAutoRetry } from "./retry/FailedRunAutoRetry.ts";
import * as ThreadScheduleRunner from "./schedules/ThreadScheduleToolkit.ts";
import * as ThreadWorkflowRunner from "./workflows/ThreadWorkflowToolkit.ts";
import * as ForkTurnContext from "./turnContext/ForkTurnContext.ts";

/** Needs only SqlClient; merged next to upstream persistence. */
export const layerForkRepositories = Layer.mergeAll(
  AgentMemories.layer,
  ThreadLedgerRepository.layer,
  ArtifactRepository.layer,
  ThreadScheduleRepository.layer,
  ThreadWorkflowRepository.layer,
);

/** Provided to the V2 runtime so turn start can read it. */
export const layerForkRuntime = ForkTurnContext.layer;

/** Long-running fork workers, parked until server activation. */
export const layerForkBackground = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* startMemorySync;
    yield* startMsgHubNotifications;
    yield* startFailedRunAutoRetry;
    yield* ThreadScheduleRunner.startThreadScheduleRunner;
    yield* ThreadWorkflowRunner.startThreadWorkflowRunner;
  }),
);
