import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as CodexManagedTokenBroker from "../../provider/CodexManagedTokenBroker.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  CommandId,
  type ModelSelection,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ResetCreditCoordinator from "../../provider/resetCreditCoordinator.ts";
import { FetchHttpClient } from "effect/http";
import { describe } from "vite-plus/test";

import { migrateLegacyForkProviderInstance } from "./legacyForkProviderInstances.ts";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../../background/HostPowerMonitor.ts";
import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as AntigravityInstallation from "../../provider/AntigravityInstallation.ts";
import * as CodexInstallation from "../../provider/CodexInstallation.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ModelManifest from "../../provider/ModelManifest.ts";
import * as ProviderInstanceRegistryHydration from "../../provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as ServerSettings from "../../serverSettings.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderTurnStartServiceTestkit from "../../orchestration-v2/ProviderTurnStartService.testkit.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as FileSystem from "effect/FileSystem";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

// Runs a fork provider (kiro, factory or minimax) for real through the V2
// harness, with the instance config produced by the legacy-settings migration.
//   T3_FORK_ACP_LIVE=kiro|factory|minimax  T3_FORK_ACP_MODEL=<model slug>
//   T3_FORK_ACP_COMMAND overrides the executable (e.g. the Factory wrapper path).
const legacyProvider = process.env.T3_FORK_ACP_LIVE?.trim() ?? "";
const legacyInstances: Record<string, Record<string, unknown>> = {
  kiro: { driver: "kiro", config: { binaryPath: "kiro-cli", agentEngine: "v2", agent: "t3" } },
  factory: {
    driver: "factory",
    config: {
      binaryPath: process.env.T3_FORK_FACTORY_DROID_BIN ?? "droid",
      apiKeyEtcdKey: process.env.T3_FORK_FACTORY_ETCD_KEY ?? "",
    },
  },
  minimax: {
    driver: "minimax",
    config: { binaryPath: "mcode", dataDir: process.env.T3_FORK_MINIMAX_DATA_DIR ?? "" },
  },
};
const migratedInstance = migrateLegacyForkProviderInstance(
  legacyInstances[legacyProvider] ?? { driver: "none" },
);
const liveCommandPath = process.env.T3_FORK_ACP_COMMAND?.trim();
const liveAgentId = legacyProvider;
const liveInstanceId = ProviderInstanceId.make(legacyProvider || "fork_live");
const liveModelSelection = {
  instanceId: liveInstanceId,
  model: process.env.T3_FORK_ACP_MODEL?.trim() || "default",
} satisfies ModelSelection;

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-acp-registry-v2-live-",
});

const layerVcsDriverRegistry = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStore = CheckpointStore.layer.pipe(Layer.provide(layerVcsDriverRegistry));

const layerServerSettings = ServerSettings.layerTest({
  providerInstances: {
    [liveInstanceId]: {
      ...(migratedInstance as object),
      driver: ProviderDriverKind.make("acpRegistry"),
      enabled: true,
      config: {
        ...(migratedInstance.config as object),
        ...(liveCommandPath ? { commandPath: liveCommandPath } : {}),
      },
    } as never,
  },
});
const layerBackgroundPolicy = BackgroundPolicy.layer.pipe(
  Layer.provide(Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make())),
  Layer.provide(layerServerSettings),
);
const layerProviderInstanceRegistry = ProviderInstanceRegistryHydration.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerServerConfig.pipe(Layer.provide(layerPlatformTest)),
      layerServerSettings,
      ServerSecretStore.layer.pipe(
        Layer.provide(layerServerConfig),
        Layer.provide(layerPlatformTest),
      ),
      NodeServices.layer,
      FetchHttpClient.layer,
      // The live ACP test never starts a managed Codex turn.
      Layer.mock(CodexManagedTokenBroker.CodexManagedTokenBroker)({
        endpoint: Effect.succeed("unused-private-pipe"),
      }),
      OpenCodeRuntime.layer.pipe(
        Layer.provide(OpenCodeServerLedger.layerTest),
        Layer.provide(layerPlatformTest),
      ),
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
      ProviderLatestVersions.layer,
      ModelManifest.layerTest,
      AntigravityInstallation.AntigravityInstallation.layer.pipe(
        Layer.provide(layerServerConfig.pipe(Layer.provide(layerPlatformTest))),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(layerPlatformTest),
      ),
      Layer.mock(CodexInstallation.CodexInstallation)({
        managedDirectory: "unused-managed-installation",
      }),
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
    ),
  ),
);

const noEnrichment = {
  repositoryIdentity: null,
  faviconPath: null,
  repositoryIdentityResolved: true,
};

const layerLive = Layer.mergeAll(
  RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService)),
  RuntimeLayer.layerProjectService,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStore),
  Layer.provide(layerServerConfig),
  Layer.provide(layerServerSettings),
  Layer.provide(layerProviderInstanceRegistry),
  Layer.provide(ResetCreditCoordinator.layer),
  Layer.provide(layerBackgroundPolicy),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(layerPlatformTest),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(WorkspacePaths.layer.pipe(Layer.provide(NodeServices.layer))),
  Layer.provide(
    Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
      peek: () => Effect.succeed(noEnrichment),
      getAvailable: () => Effect.succeed(noEnrichment),
      request: () => Effect.void,
      invalidate: () => Effect.void,
    }),
  ),
);

const waitForIdle = Effect.fn("AcpRegistryOrchestratorV2Live.waitForIdle")(function* (
  threadId: ThreadId,
  expectedRunCount: number,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const projection = yield* orchestrator.getThreadProjection(threadId);
    if (
      projection.runs.length >= expectedRunCount &&
      projection.runs.every(
        (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
      )
    ) {
      return projection;
    }
    yield* Effect.sleep("500 millis");
  }
  const stuck = yield* orchestrator.getThreadProjection(threadId);
  return yield* Effect.die(
    new Error(
      `Timed out waiting for thread ${threadId}: ${JSON.stringify({
        runs: stuck.runs.map((run) => [run.status, run.providerInstanceId]),
        sessions: stuck.providerSessions,
        requests: stuck.runtimeRequests,
        messages: stuck.messages.map((message) => [message.role, message.text.slice(0, 120)]),
        items: stuck.turnItems.slice(-8).map((item) => item.type),
      }).slice(0, 4000)}`,
    ),
  );
});

describe.runIf(legacyProvider in legacyInstances)("fork ACP providers V2 live orchestrator", () => {
  it.live(
    `runs and resumes ${legacyProvider} through the production V2 harness`,
    () =>
      Effect.gen(function* () {
        yield* EffectWorker.runDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projectId = ProjectId.make("project:acp-registry-live");
        const threadId = ThreadId.make("thread:acp-registry-live");
        const marker = "ACP_REGISTRY_LIVE_7H3Q";

        const workspaceRoot = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "t3-fork-acp-",
        });
        yield* (yield* ProjectService.ProjectService).create({
          commandId: CommandId.make("command:acp-registry-live:project"),
          projectId,
          title: "fork ACP live",
          workspaceRoot,
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:acp-registry-live:create"),
          threadId,
          projectId,
          title: `ACP Registry live: ${liveAgentId}`,
          modelSelection: liveModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        yield* Console.log(
          `ACP Registry thread created for '${liveAgentId}'; dispatching first prompt.`,
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:acp-registry-live:first"),
          threadId,
          messageId: MessageId.make("message:acp-registry-live:first"),
          text: `Remember this opaque marker. Respond with exactly: ${marker}`,
          attachments: [],
          modelSelection: liveModelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const firstProjection = yield* waitForIdle(threadId, 1);
        yield* Console.log(
          `first run: ${JSON.stringify({ turns: firstProjection.providerTurns, items: firstProjection.turnItems.filter((item) => item.type !== "user_message") }).slice(0, 4000)}`,
        );
        const firstAssistant = firstProjection.messages.findLast(
          (message) => message.role === "assistant",
        )?.text;

        assert.deepEqual(
          firstProjection.runs.map((run) => [run.providerInstanceId, run.status]),
          [[liveInstanceId, "completed"]],
        );
        assert.include(firstAssistant ?? "", marker);

        yield* Console.log("First ACP turn completed; dispatching continuation prompt.");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:acp-registry-live:second"),
          threadId,
          messageId: MessageId.make("message:acp-registry-live:second"),
          text: "Return the opaque marker from the previous turn. Respond with only the marker.",
          attachments: [],
          modelSelection: liveModelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const finalProjection = yield* waitForIdle(threadId, 2);
        const finalAssistant = finalProjection.messages.findLast(
          (message) => message.role === "assistant",
        )?.text;

        assert.deepEqual(
          finalProjection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            [liveInstanceId, "completed"],
            [liveInstanceId, "completed"],
          ],
        );
        assert.include(finalAssistant ?? "", marker);
        assert.isAtLeast(finalProjection.providerSessions.length, 1);
        assert.isAtLeast(finalProjection.providerThreads.length, 1);
        assert.deepEqual(
          finalProjection.providerTurns.map((turn) => turn.status),
          ["completed", "completed"],
        );
      }).pipe(Effect.provide(Layer.merge(layerLive, NodeServices.layer)), Effect.scoped),
    480_000,
  );
});
