import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { vi } from "vite-plus/test";
import { expect, it } from "@effect/vitest";

import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";

import * as ServerConfig from "./config.ts";
import { ServerLoggerLive } from "./serverLogger.ts";

// ServerLoggerLive references the OTLP exporter unconditionally; the layer
// builds it lazily but the type-level requirement stays.
const httpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => Effect.die(new Error(`unexpected http call: ${request.url}`))),
);

const configLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const baseDir = path.join(NodeOS.tmpdir(), "t3-filelogger-test");
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
    return ServerConfig.make({
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: false,
      traceBatchWindowMs: 200,
      traceMaxBytes: 1024,
      traceMaxFiles: 1,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
      otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
      otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
      otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
      otlpServiceName: "t3-server",
      cwd: baseDir,
      baseDir,
      ...derivedPaths,
      mode: "web",
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      port: 0,
      host: undefined,
      desktopBootstrapToken: undefined,
      desktopTelemetryFd: undefined,
      desktopTelemetryControlFd: undefined,
      resourceMonitorPath: undefined,
      staticDir: undefined,
      devUrl: undefined,
      devAllowedOrigins: [],
      noBrowser: false,
      startupPresentation: "browser",
    });
  }),
).pipe(Layer.provide(NodePath.layer));

it.live("mirrors pretty logs to T3CODE_PRETTY_LOG_FILE without colors", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      import("node:fs/promises").then((fs) => fs.mkdtemp(`${NodeOS.tmpdir()}/t3-filelog-`)),
    );
    const logFile = `${dir}/boot.log`;
    vi.stubEnv("T3CODE_PRETTY_LOG_FILE", logFile);
    try {
      const scope = yield* Scope.make();
      yield* Effect.gen(function* () {
        yield* Effect.logInfo("mirror-info-line");
        yield* Effect.logWarning("mirror-warn-line").pipe(
          Effect.annotateLogs("environment.endpoint", "translate"),
        );
        yield* Effect.logInfo("mirror-structured-line", { upserted: 48, removed: 0 });
      }).pipe(
        Effect.provide(
          ServerLoggerLive.pipe(
            Layer.provide(Layer.mergeAll(configLayer, httpClientLayer, NodeFileSystem.layer)),
          ),
        ),
        Effect.provideService(Scope.Scope, scope),
      );
      // The file logger batches (1s window) and flushes on scope close.
      yield* Scope.close(scope, Exit.succeed(undefined));
      const text = yield* Effect.promise(() =>
        import("node:fs/promises").then((fs) => fs.readFile(logFile, "utf8")),
      );
      expect(text).toContain("INFO");
      expect(text).toContain("mirror-info-line");
      expect(text).toContain("WARN");
      expect(text).toContain("mirror-warn-line");
      expect(text).toContain("environment.endpoint: translate");
      // Structured messages render as JSON, not "[object Object]".
      expect(text).toContain('"upserted": 48');
      expect(text).not.toContain("[object Object]");
      expect(text.includes(String.fromCharCode(27))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  }),
);
