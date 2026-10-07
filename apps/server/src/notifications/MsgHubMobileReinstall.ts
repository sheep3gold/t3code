// Publishes a mobile reinstall event through msghub so ai-ops can renew its
// expiry ledger (Personal Team 7-day iOS signing). The anchor comes from the
// mobile app's per-install sandbox file; a changed value on a WebSocket connect
// means the app was reinstalled. Fire-and-forget: a publish failure must never
// affect the connection path.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off -- plain payload builders that parse caller-provided ISO timestamps.
// @effect-diagnostics globalConsole:off -- promise-based fire-and-forget outside the Effect runtime; callers do not await or catch it.
import * as NodeCrypto from "node:crypto";

import {
  buildMsgHubPublishRequest,
  publishMsgHubRequest,
  resolveMsgHubPublisherConfig,
  type MsgHubEnvironment,
  type MsgHubFetch,
  type MsgHubPublishRequest,
  type MsgHubPublisherConfig,
} from "./MsgHubPublisher.ts";

export const DEFAULT_MOBILE_REINSTALL_SUBJECT = "aiops.renew.t3code-ios";
const MAX_ANCHOR_LENGTH = 64;

export interface MsgHubMobileReinstallConfig extends MsgHubPublisherConfig {
  readonly subject: string;
}

export interface MobileReinstallNotificationInput {
  /** ISO timestamp of the install anchor reported by the client. */
  readonly installedAt: string;
  readonly deviceModel?: string | undefined;
  readonly os?: string | undefined;
  readonly appVersion?: string | undefined;
}

export function resolveMsgHubMobileReinstallConfig(
  environment: MsgHubEnvironment = process.env,
): MsgHubMobileReinstallConfig | null {
  const base = resolveMsgHubPublisherConfig(environment);
  if (base === null) return null;
  return {
    ...base,
    subject: environment.T3CODE_MSGHUB_RENEW_SUBJECT?.trim() || DEFAULT_MOBILE_REINSTALL_SUBJECT,
  };
}

export function shouldNotifyMobileReinstall(input: {
  readonly surface?: string | undefined;
  readonly installedAt?: string | undefined;
  readonly previousInstalledAt: string | null;
}): boolean {
  return (
    input.surface === "mobile" &&
    input.installedAt !== undefined &&
    input.installedAt !== "" &&
    input.installedAt !== input.previousInstalledAt
  );
}

export function buildMsgHubMobileReinstallRequest(
  input: MobileReinstallNotificationInput,
  config: MsgHubMobileReinstallConfig,
): MsgHubPublishRequest {
  const payload = {
    installed_at: input.installedAt.slice(0, MAX_ANCHOR_LENGTH),
    ...(input.deviceModel ? { device: input.deviceModel } : {}),
    ...(input.os ? { os: input.os } : {}),
    ...(input.appVersion ? { app_version: input.appVersion } : {}),
    source: "t3code/mobile",
    host: config.hostLabel,
    ts: Math.floor(new Date(input.installedAt).getTime() / 1_000),
  };
  // Deterministic per (host, install): msghub dedupes within the window and the
  // consumer is idempotent on the same anchor.
  const digest = NodeCrypto.createHash("sha1")
    .update(`${config.hostLabel}|${payload.installed_at}`)
    .digest("hex")
    .slice(0, 16);
  return buildMsgHubPublishRequest({
    config,
    subject: config.subject,
    payload,
    messageId: `t3-reinstall-${digest}`,
  });
}

export async function publishMobileReinstallNotification(
  input: MobileReinstallNotificationInput,
  options: {
    readonly environment?: MsgHubEnvironment;
    readonly fetch?: MsgHubFetch;
  } = {},
): Promise<"disabled" | "sent" | "failed"> {
  const config = resolveMsgHubMobileReinstallConfig(options.environment);
  if (config === null) return "disabled";
  try {
    await publishMsgHubRequest(
      buildMsgHubMobileReinstallRequest(input, config),
      options.fetch ?? globalThis.fetch,
    );
    return "sent";
  } catch (error) {
    console.warn(
      "[msghub] mobile reinstall publish failed:",
      error instanceof Error ? error.message : String(error),
    );
    return "failed";
  }
}
