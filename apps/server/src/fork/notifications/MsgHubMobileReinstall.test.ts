import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildMsgHubMobileReinstallRequest,
  DEFAULT_MOBILE_REINSTALL_SUBJECT,
  publishMobileReinstallNotification,
  resolveMsgHubMobileReinstallConfig,
  shouldNotifyMobileReinstall,
  type MsgHubMobileReinstallConfig,
} from "./MsgHubMobileReinstall.ts";

const config: MsgHubMobileReinstallConfig = {
  baseUrl: "https://mq.example.test",
  token: "test-token",
  subject: DEFAULT_MOBILE_REINSTALL_SUBJECT,
  hostLabel: "tencent-124",
};

const anchor = "2026-10-07T08:00:00.000Z";

describe("MsgHubMobileReinstall", () => {
  it("is disabled unless both the flag and token are present", () => {
    expect(resolveMsgHubMobileReinstallConfig({})).toBeNull();
    expect(resolveMsgHubMobileReinstallConfig({ T3CODE_MSGHUB_NOTIFY: "1" })).toBeNull();
    expect(
      resolveMsgHubMobileReinstallConfig({
        T3CODE_MSGHUB_NOTIFY: "1",
        T3CODE_MSGHUB_TOKEN: "token",
      }),
    ).toMatchObject({
      token: "token",
      subject: DEFAULT_MOBILE_REINSTALL_SUBJECT,
      hostLabel: expect.any(String),
    });
  });

  it("honors the subject override env var", () => {
    expect(
      resolveMsgHubMobileReinstallConfig({
        T3CODE_MSGHUB_NOTIFY: "1",
        T3CODE_MSGHUB_TOKEN: "token",
        T3CODE_MSGHUB_RENEW_SUBJECT: "aiops.renew.other-device",
      }),
    ).toMatchObject({ subject: "aiops.renew.other-device" });
  });

  it("only fires for mobile surfaces when the install anchor changed", () => {
    expect(
      shouldNotifyMobileReinstall({
        surface: "mobile",
        installedAt: anchor,
        previousInstalledAt: null,
      }),
    ).toBe(true);
    expect(
      shouldNotifyMobileReinstall({
        surface: "mobile",
        installedAt: anchor,
        previousInstalledAt: anchor,
      }),
    ).toBe(false);
    expect(
      shouldNotifyMobileReinstall({
        surface: "desktop",
        installedAt: anchor,
        previousInstalledAt: null,
      }),
    ).toBe(false);
    expect(shouldNotifyMobileReinstall({ surface: "mobile", previousInstalledAt: null })).toBe(
      false,
    );
  });

  it("builds an idempotent request carrying the install anchor", () => {
    const first = buildMsgHubMobileReinstallRequest(
      { installedAt: anchor, deviceModel: "iPhone", os: "iOS", appVersion: "1.3.1" },
      config,
    );
    const second = buildMsgHubMobileReinstallRequest({ installedAt: anchor }, config);
    const envelope = JSON.parse(first.body) as {
      subject: string;
      payload: string;
      msg_id: string;
    };
    const payload = JSON.parse(envelope.payload) as Record<string, unknown>;

    expect(first.url).toBe("https://mq.example.test/api/publish");
    expect(first.headers.Authorization).toBe("Bearer test-token");
    expect(envelope.subject).toBe("aiops.renew.t3code-ios");
    expect(envelope.msg_id).toBe((JSON.parse(second.body) as typeof envelope).msg_id);
    expect(payload.installed_at).toBe(anchor);
    expect(payload.host).toBe("tencent-124");
    expect(payload.device).toBe("iPhone");
    expect((JSON.parse(second.body) as typeof envelope).payload).not.toContain('"device"');
  });

  it("never throws: transport failure resolves to failed", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response("nope", { status: 503 })));
    const result = await publishMobileReinstallNotification(
      { installedAt: anchor },
      {
        environment: {
          T3CODE_MSGHUB_NOTIFY: "1",
          T3CODE_MSGHUB_TOKEN: "token",
        },
        fetch: fetch as unknown as typeof globalThis.fetch,
      },
    );
    expect(result).toBe("failed");
    expect(fetch).toHaveBeenCalled();
  });

  it("reports sent on a 2xx transport", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    const result = await publishMobileReinstallNotification(
      { installedAt: anchor },
      {
        environment: {
          T3CODE_MSGHUB_NOTIFY: "1",
          T3CODE_MSGHUB_TOKEN: "token",
        },
        fetch: fetch as unknown as typeof globalThis.fetch,
      },
    );
    expect(result).toBe("sent");
  });
});
