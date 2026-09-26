import { describe, expect, it, vi } from "vitest";

import {
  buildMsgHubTurnCompletionRequest,
  publishTurnCompletionNotification,
  resolveMsgHubTurnCompletionConfig,
  type MsgHubTurnCompletionConfig,
  type TurnCompletionNotificationInput,
} from "./MsgHubTurnCompletion.ts";

const config: MsgHubTurnCompletionConfig = {
  baseUrl: "https://mq.example.test",
  token: "test-token",
  subject: "dingding.notify.vibecoding.t3code.turn.done",
  hostLabel: "t3-host",
};

const input: TurnCompletionNotificationInput = {
  threadId: "thread-1",
  turnId: "turn-2",
  project: "t3code",
  threadTitle: "Add notifications",
  provider: "codex",
  state: "completed",
  text: "Done.\n\n```ts\nconst secret = 'not useful on mobile';\n```\n\n[OPTIONS: retry | stop]",
  createdAt: "2026-09-26T10:00:00.000Z",
};

describe("MsgHubTurnCompletion", () => {
  it("is disabled unless both the flag and token are present", () => {
    expect(resolveMsgHubTurnCompletionConfig({})).toBeNull();
    expect(resolveMsgHubTurnCompletionConfig({ T3CODE_MSGHUB_NOTIFY: "1" })).toBeNull();
    expect(
      resolveMsgHubTurnCompletionConfig({
        T3CODE_MSGHUB_NOTIFY: "1",
        T3CODE_MSGHUB_TOKEN: "token",
        T3CODE_MSGHUB_HOST_LABEL: "server-124",
      }),
    ).toMatchObject({ token: "token", hostLabel: "server-124" });
  });

  it("builds a mobile-safe, idempotent msghub request", () => {
    const first = buildMsgHubTurnCompletionRequest(input, config);
    const second = buildMsgHubTurnCompletionRequest(input, config);
    const envelope = JSON.parse(first.body) as {
      subject: string;
      payload: string;
      msg_id: string;
    };
    const payload = JSON.parse(envelope.payload) as {
      title: string;
      text: string;
      level: string;
      fields: Record<string, string>;
    };

    expect(first.url).toBe("https://mq.example.test/api/publish");
    expect(first.headers.Authorization).toBe("Bearer test-token");
    expect(envelope.subject).toBe(config.subject);
    expect(envelope.msg_id).toBe((JSON.parse(second.body) as typeof envelope).msg_id);
    expect(payload.title).toBe("[t3-host] ✅ T3Code(t3code) 回复完成");
    expect(payload.text).toBe("Done.\n〔代码块〕");
    expect(payload.text).not.toContain("OPTIONS");
    expect(payload.level).toBe("success");
    expect(payload.fields).toMatchObject({ Provider: "codex", 状态: "completed" });
  });

  it("uses failure details when a failed turn has no assistant text", () => {
    const request = buildMsgHubTurnCompletionRequest(
      { ...input, state: "failed", text: "", errorMessage: "Provider unavailable" },
      config,
    );
    const envelope = JSON.parse(request.body) as { payload: string };
    const payload = JSON.parse(envelope.payload) as {
      title: string;
      text: string;
      level: string;
    };

    expect(payload.title).toContain("❌");
    expect(payload.text).toBe("Provider unavailable");
    expect(payload.level).toBe("failed");
  });

  it("does not touch the network while disabled", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      publishTurnCompletionNotification(input, { environment: {}, fetch }),
    ).resolves.toBe("disabled");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts the configured subject when enabled", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ seq: 42, duplicate: false }), { status: 200 }),
    );
    await expect(
      publishTurnCompletionNotification(input, {
        environment: {
          T3CODE_MSGHUB_NOTIFY: "1",
          T3CODE_MSGHUB_TOKEN: "test-token",
          T3CODE_MSGHUB_URL: "https://mq.example.test/",
          T3CODE_MSGHUB_HOST_LABEL: "server-124",
        },
        fetch,
      }),
    ).resolves.toBe("sent");

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://mq.example.test/api/publish");
    expect(request?.method).toBe("POST");
    expect(request?.headers).toMatchObject({ Authorization: "Bearer test-token" });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      subject: "dingding.notify.vibecoding.t3code.turn.done",
    });
  });
});
