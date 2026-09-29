import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildAgentNotification,
  DEFAULT_AGENT_NOTIFICATION_SUBJECT,
  publishAgentNotification,
} from "./AgentNotification.ts";

describe("AgentNotification", () => {
  it("builds the standard thread-scoped envelope", () => {
    const payload = buildAgentNotification({
      title: "Build complete",
      text: "All checks passed",
      level: "success",
      threadId: "thread-1",
      threadTitle: "Ship feature",
      project: "t3code",
      hostLabel: "server-124",
      createdAt: "2026-09-26T12:00:00.000Z",
    });
    expect(payload).toMatchObject({
      title: "[server-124] Build complete",
      text: "All checks passed",
      level: "success",
      source: "t3code/t3code",
      fields: { Thread: "thread-1", 类型: "agent" },
    });
  });

  it("uses the restricted subject and stable dedupe key", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const input = {
      title: "Done",
      text: "Finished",
      level: "info" as const,
      threadId: "thread-1",
      threadTitle: "Task",
      project: "t3code",
      dedupeKey: "job-1",
      createdAt: "2026-09-26T12:00:00.000Z",
    };
    const environment = {
      T3CODE_MSGHUB_NOTIFY: "1",
      T3CODE_MSGHUB_TOKEN: "test-token",
      T3CODE_MSGHUB_URL: "https://mq.example.test",
      T3CODE_MSGHUB_HOST_LABEL: "server-124",
    };
    const first = await publishAgentNotification(input, { environment, fetch });
    const second = await publishAgentNotification(input, { environment, fetch });
    expect(first.messageId).toBe(second.messageId);
    const envelope = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as {
      subject: string;
      msg_id: string;
    };
    expect(envelope.subject).toBe(DEFAULT_AGENT_NOTIFICATION_SUBJECT);
    expect(envelope.msg_id).toBe(first.messageId);
  });

  it("does not touch the network while disabled", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const result = await publishAgentNotification(
      {
        title: "Done",
        text: "Finished",
        level: "info",
        threadId: "thread-1",
        threadTitle: "Task",
        project: "t3code",
        dedupeKey: "job-1",
        createdAt: "2026-09-26T12:00:00.000Z",
      },
      { environment: {}, fetch },
    );
    expect(result.status).toBe("disabled");
    expect(fetch).not.toHaveBeenCalled();
  });
});
