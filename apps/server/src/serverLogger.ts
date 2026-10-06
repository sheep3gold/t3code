import { otlpSerializationLayer } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redactable from "effect/Redactable";
import * as References from "effect/References";
import * as OtlpExporter from "effect/unstable/observability/OtlpExporter";
import * as OtlpLogger from "effect/unstable/observability/OtlpLogger";

import { otlpResource, ServerConfig } from "./config.ts";

const twoDigits = (value: number) => value.toString().padStart(2, "0");

/** Same layout as `Logger.consolePretty` on a pipe, minus the colors. */
const formatPrettyPlain = (
  date: Date,
  logLevel: string,
  fiberId: number,
  spans: Iterable<string>,
  message: ReadonlyArray<unknown>,
  cause: Cause.Cause<unknown>,
  annotations: Record<string, unknown>,
) => {
  const hh = twoDigits(date.getHours());
  const mm = twoDigits(date.getMinutes());
  const ss = twoDigits(date.getSeconds());
  const ms = date.getMilliseconds().toString().padStart(3, "0");
  let firstLine = `[${hh}:${mm}:${ss}.${ms}] ${logLevel.toUpperCase()} (#${fiberId})`;
  for (const span of spans) firstLine += ` ${span}`;
  firstLine += ":";

  const lines: Array<string> = [];
  let messageIndex = 0;
  if (message.length > 0 && typeof message[0] === "string") {
    firstLine += ` ${message[0]}`;
    messageIndex++;
  }
  lines.push(firstLine);
  if (cause.reasons.length > 0) lines.push(Cause.pretty(cause));
  for (; messageIndex < message.length; messageIndex++) {
    lines.push(String(Redactable.redact(message[messageIndex])));
  }
  for (const [key, value] of Object.entries(annotations)) {
    lines.push(`${key}: ${String(Redactable.redact(value))}`);
  }
  return lines.join("\n");
};

/**
 * Duplicate of the console pretty logger that renders to a string, so the
 * boot-service log file stays readable after stdout moves to the journal.
 * Kept in sync with the renderer in `Logger.consolePretty` on purpose — this
 * file is what an operator reads first when the service misbehaves.
 */
const prettyFileLogger = Effect.fn("serverLogger.prettyFileLogger")(function* (path: string) {
  const formatter = Logger.make<unknown, string>(({ cause, date, fiber, logLevel, message }) => {
    const now = date.getTime();
    const spans = fiber
      .getRef(References.CurrentLogSpans)
      .map(([label, timestamp]) => `${label}=${now - timestamp}ms`);
    const annotations = Object.fromEntries(
      Object.entries(fiber.getRef(References.CurrentLogAnnotations)).map(([key, value]) => [
        key,
        Redactable.redact(value),
      ]),
    );
    return formatPrettyPlain(
      date,
      logLevel,
      fiber.id,
      spans,
      Array.isArray(message) ? message : [message],
      cause,
      annotations,
    );
  });
  return yield* Logger.toFile(formatter, path);
});

export const ServerLoggerLive = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const minimumLogLevelLayer = Layer.succeed(References.MinimumLogLevel, config.logLevel);

  const logs = config.otlpLogsExport;
  const otlpLogger =
    config.otlpLogsUrl === undefined
      ? undefined
      : OtlpLogger.make({
          url: config.otlpLogsUrl,
          exportInterval: `${logs.exportIntervalMs} millis`,
          headers: logs.headers,
          resource: otlpResource(config),
        });

  // Optional plain-text mirror of the console pretty logger. The systemd unit
  // sends stdout to the journal only; units that still want the on-disk
  // boot-service log set T3CODE_PRETTY_LOG_FILE to the file path.
  const prettyLogPath = process.env.T3CODE_PRETTY_LOG_FILE?.trim();
  const fileLogger = prettyLogPath ? yield* prettyFileLogger(prettyLogPath) : undefined;

  // `Logger.layer` writes the whole logger set rather than adding to it, so
  // every logger the server wants has to be named in this one call.
  //
  // `Logger.tracerLogger` reaches a collector by attaching each message to the
  // active span as a span event, which covers only messages logged inside a
  // recorded span and files them under traces. The OTLP logger carries the same
  // messages as log records stamped with their trace and span ids, so it is a
  // superset: keeping both would export every in-span message twice.
  //
  // Recording events on spans is also the shape OpenTelemetry is deprecating,
  // in favor of the log-based events this logger emits:
  // https://opentelemetry.io/blog/2026/deprecating-span-events/
  const loggerLayer = Logger.layer(
    [
      Logger.consolePretty(),
      ...(otlpLogger === undefined ? [Logger.tracerLogger] : [otlpLogger]),
      ...(fileLogger === undefined ? [] : [fileLogger]),
    ],
    { mergeWithExisting: false },
  ).pipe(
    Layer.provide(OtlpExporter.layerFlusher),
    Layer.provide(otlpSerializationLayer(logs.protocol)),
  );

  return Layer.mergeAll(loggerLayer, minimumLogLevelLayer);
}).pipe(Layer.unwrap);
