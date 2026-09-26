import { describe, expect, it, vi } from "vitest";

import {
  buildMsgHubAttentionRequest,
  publishAttentionNotification,
  resolveMsgHubAttentionConfig,
  type AttentionNotificationInput,
} from "./MsgHubAttentionNotification.ts";
import type { MsgHubTurnCompletionConfig } from "./MsgHubTurnCompletion.ts";

const config: MsgHubTurnCompletionConfig = {
  baseUrl: "https://mq.example.test",
  token: "test-token",
  subject: "dingding.notify.vibecoding.t3code.approval.required",
  hostLabel: "t3-host",
};

const input: AttentionNotificationInput = {
  kind: "approval",
  eventId: "event-1",
  requestId: "request-1",
  threadId: "thread-1",
  turnId: "turn-1",
  project: "t3code",
  threadTitle: "Add notifications",
  provider: "codex",
  text: "Command approval required",
  createdAt: "2026-09-26T10:00:00.000Z",
};

describe("MsgHubAttentionNotification", () => {
  it("uses separate default subjects behind the existing explicit opt-in", () => {
    expect(resolveMsgHubAttentionConfig("approval", {})).toBeNull();
    const environment = {
      T3CODE_MSGHUB_NOTIFY: "1",
      T3CODE_MSGHUB_TOKEN: "token",
    };
    expect(resolveMsgHubAttentionConfig("approval", environment)?.subject).toBe(
      "dingding.notify.vibecoding.t3code.approval.required",
    );
    expect(resolveMsgHubAttentionConfig("user-input", environment)?.subject).toBe(
      "dingding.notify.vibecoding.t3code.user-input.required",
    );
  });

  it("builds a mobile-safe request idempotent by request", () => {
    const first = buildMsgHubAttentionRequest(input, config);
    const second = buildMsgHubAttentionRequest({ ...input, eventId: "event-replayed" }, config);
    const envelope = JSON.parse(first.body) as {
      subject: string;
      payload: string;
      msg_id: string;
    };
    const repeated = JSON.parse(second.body) as typeof envelope;
    const payload = JSON.parse(envelope.payload) as {
      title: string;
      text: string;
      fields: Record<string, string>;
    };

    expect(envelope.subject).toBe(config.subject);
    expect(envelope.msg_id).toBe(repeated.msg_id);
    expect(payload.title).toBe("[t3-host] ⏳ T3Code(t3code) 等待审批");
    expect(payload.text).toBe("Command approval required");
    expect(payload.fields).toMatchObject({ Provider: "codex", 类型: "approval" });
  });

  it("does not touch the network while disabled", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      publishAttentionNotification(input, { environment: {}, fetch }),
    ).resolves.toBe("disabled");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts the user-input subject when enabled", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ seq: 43, duplicate: false }), { status: 200 }),
    );
    await expect(
      publishAttentionNotification(
        { ...input, kind: "user-input", text: "Which mode should be used?" },
        {
          environment: {
            T3CODE_MSGHUB_NOTIFY: "1",
            T3CODE_MSGHUB_TOKEN: "test-token",
          },
          fetch,
        },
      ),
    ).resolves.toBe("sent");

    const [, request] = fetch.mock.calls[0] ?? [];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      subject: "dingding.notify.vibecoding.t3code.user-input.required",
    });
  });
});
