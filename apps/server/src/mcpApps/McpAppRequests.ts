import {
  McpAppRequestError,
  type McpAppCallToolInput,
  type McpAppCallToolResult,
  type McpAppReadResourceInput,
  type McpAppReadResourceResult,
  type McpAppToolInfo,
  type McpAppToolInfoInput,
  type McpAppUpdateModelContextInput,
  type ThreadId,
} from "@t3tools/contracts";
import { mcpAppFromActivity, mcpAppToolCallableByApp } from "@t3tools/shared/mcpApp";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { McpAppModelContext, MCP_APP_MODEL_CONTEXT_MAX_BYTES } from "./McpAppModelContext.ts";

export class McpAppRequests extends Context.Service<
  McpAppRequests,
  {
    readonly callTool: (
      input: McpAppCallToolInput,
    ) => Effect.Effect<McpAppCallToolResult, McpAppRequestError>;
    readonly toolInfo: (
      input: McpAppToolInfoInput,
    ) => Effect.Effect<McpAppToolInfo, McpAppRequestError>;
    readonly readResource: (
      input: McpAppReadResourceInput,
    ) => Effect.Effect<McpAppReadResourceResult, McpAppRequestError>;
    readonly updateModelContext: (
      input: McpAppUpdateModelContextInput,
    ) => Effect.Effect<void, McpAppRequestError>;
  }
>()("t3/mcpApps/McpAppRequests") {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const utf8 = new TextEncoder();

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory;
  const registry = yield* ProviderAdapterRegistry;
  const modelContext = yield* McpAppModelContext;
  const fail = (threadId: ThreadId, reason: McpAppRequestError["reason"], cause?: unknown) =>
    new McpAppRequestError({ threadId, reason, ...(cause === undefined ? {} : { cause }) });

  const resolveApp = Effect.fn("McpAppRequests.resolveApp")(function* (input: {
    readonly threadId: ThreadId;
    readonly toolCallId: string;
  }) {
    const activity = Option.getOrUndefined(
      yield* snapshots
        .getMcpAppActivity(input)
        .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause))),
    );
    const app = activity === undefined ? undefined : mcpAppFromActivity(activity);
    if (!app) return yield* fail(input.threadId, "not-an-app");
    return app;
  });

  const resolve = Effect.fn("McpAppRequests.resolve")(function* (input: {
    readonly threadId: ThreadId;
    readonly toolCallId: string;
  }) {
    const app = yield* resolveApp(input);
    const binding = Option.getOrUndefined(
      yield* directory
        .getBinding(input.threadId)
        .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause))),
    );
    if (binding?.providerInstanceId === undefined) {
      return yield* fail(input.threadId, "session-stopped");
    }
    const adapter = yield* registry
      .getByInstance(binding.providerInstanceId)
      .pipe(Effect.mapError((cause) => fail(input.threadId, "provider-unsupported", cause)));
    if (adapter.mcpApps === undefined) {
      return yield* fail(input.threadId, "provider-unsupported");
    }
    if (!(yield* adapter.hasSession(input.threadId))) {
      return yield* fail(input.threadId, "session-stopped");
    }
    return { app, operations: adapter.mcpApps };
  });

  const toolInfo = Effect.fn("McpAppRequests.toolInfo")(function* (input: McpAppToolInfoInput) {
    const { app, operations } = yield* resolve(input);
    const tools = yield* operations
      .listTools(input.threadId, app.server)
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
    const tool = tools.find((candidate) => candidate.name === input.name);
    const title = tool && typeof tool.title === "string" ? tool.title : undefined;
    const annotations = tool && Predicate.isObject(tool.annotations) ? tool.annotations : undefined;
    return {
      callable: tool !== undefined && mcpAppToolCallableByApp(tool._meta),
      readOnly: annotations?.readOnlyHint === true,
      ...(title === undefined ? {} : { title }),
      ...(tool === undefined ? {} : { tool }),
    } satisfies McpAppToolInfo;
  });

  const callTool = Effect.fn("McpAppRequests.callTool")(function* (input: McpAppCallToolInput) {
    const { app, operations } = yield* resolve(input);
    const tools = yield* operations
      .listTools(input.threadId, app.server)
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
    const tool = tools.find((candidate) => candidate.name === input.name);
    if (!tool || !mcpAppToolCallableByApp(tool._meta)) {
      return yield* fail(input.threadId, "tool-not-callable");
    }
    const response = yield* operations
      .callTool(input.threadId, app.server, input.name, input.arguments)
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
    return {
      content: [...response.content],
      ...(response.structuredContent === undefined
        ? {}
        : { structuredContent: response.structuredContent }),
      ...(response.isError === true ? { isError: true } : {}),
      ...(response._meta === undefined ? {} : { _meta: response._meta }),
    } satisfies McpAppCallToolResult;
  });

  const readResource = Effect.fn("McpAppRequests.readResource")(function* (
    input: McpAppReadResourceInput,
  ) {
    const { app, operations } = yield* resolve(input);
    const response = yield* operations
      .readResource(input.threadId, app.server, input.uri)
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
    return { contents: [...response.contents] } satisfies McpAppReadResourceResult;
  });

  const updateModelContext = Effect.fn("McpAppRequests.updateModelContext")(function* (
    input: McpAppUpdateModelContextInput,
  ) {
    const app = yield* resolveApp(input);
    // Context belongs to the conversation on screen; this fork has no
    // forked-thread lineage, so only the app's own thread qualifies.
    if (input.conversationThreadId !== input.threadId) {
      return yield* fail(input.threadId, "not-an-app");
    }
    const texts: Array<string> = [];
    for (const block of input.content ?? []) {
      if (!Predicate.isObject(block) || block.type !== "text" || typeof block.text !== "string") {
        return yield* fail(input.threadId, "unsupported-content");
      }
      texts.push(block.text);
    }
    if (input.structuredContent !== undefined) {
      texts.push(encodeJson(input.structuredContent));
    }
    // Kept as sent; blank text clears the app's context in the store.
    const text = texts.join("\n");
    if (utf8.encode(text).byteLength > MCP_APP_MODEL_CONTEXT_MAX_BYTES) {
      return yield* fail(
        input.threadId,
        "request-failed",
        new Error("Model context is too large."),
      );
    }
    yield* modelContext
      .set({
        threadId: input.conversationThreadId,
        toolCallId: input.toolCallId,
        server: app.server,
        tool: app.tool,
        text,
      })
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
  });

  return McpAppRequests.of({ callTool, toolInfo, readResource, updateModelContext });
});

export const McpAppRequestsLayerLive = Layer.effect(McpAppRequests, make);
