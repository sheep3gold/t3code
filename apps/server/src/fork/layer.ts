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

import * as AgentMemories from "./memory/AgentMemories.ts";
import { startMemorySync } from "./memory/MemorySync.ts";
import * as ForkTurnContext from "./turnContext/ForkTurnContext.ts";

/** Needs only SqlClient; merged next to upstream persistence. */
export const layerForkRepositories = AgentMemories.layer;

/** Provided to the V2 runtime so turn start can read it. */
export const layerForkRuntime = ForkTurnContext.layer;

/** Long-running fork workers, parked until server activation. */
export const layerForkBackground = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* startMemorySync;
  }),
);
