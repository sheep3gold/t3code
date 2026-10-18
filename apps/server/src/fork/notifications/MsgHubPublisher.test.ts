import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildMsgHubPublishRequest,
  publishMsgHubRequest,
  resolveMsgHubPublisherConfig,
} from "./MsgHubPublisher.ts";

describe("MsgHubPublisher", () => {
  it("requires both the explicit flag and token", () => {
    expect(resolveMsgHubPublisherConfig({})).toBeNull();
    expect(resolveMsgHubPublisherConfig({ T3CODE_MSGHUB_NOTIFY: "1" })).toBeNull();
    expect(
      resolveMsgHubPublisherConfig({
        T3CODE_MSGHUB_NOTIFY: "1",
        T3CODE_MSGHUB_TOKEN: "token",
        T3CODE_MSGHUB_HOST_LABEL: "server-124",
      }),
    ).toMatchObject({ token: "token", hostLabel: "server-124" });
  });

  it("retries 429 and 5xx but stops on permanent 4xx", async () => {
    const request = buildMsgHubPublishRequest({
      config: { baseUrl: "https://mq.test", token: "token", hostLabel: "host" },
      subject: "dingding.notify.vibecoding.t3code.agent.message",
      payload: { text: "hello" },
      messageId: "message-1",
    });
    const retrying = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await expect(publishMsgHubRequest(request, retrying)).resolves.toBeUndefined();
    expect(retrying).toHaveBeenCalledTimes(3);

    const permanent = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("forbidden", { status: 403 }));
    await expect(publishMsgHubRequest(request, permanent)).rejects.toThrow("HTTP 403");
    expect(permanent).toHaveBeenCalledTimes(1);
  }, 10_000);
});
