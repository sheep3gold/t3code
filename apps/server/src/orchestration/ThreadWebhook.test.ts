import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "@t3tools/contracts";

import {
  decodeThreadWebhookToken,
  encodeThreadWebhookToken,
  formatThreadWebhookCallbackText,
  resolveThreadWebhookUrl,
  type ThreadWebhookClaims,
} from "./ThreadWebhook.ts";

const secret = new TextEncoder().encode("01234567890123456789012345678901");
const claims: ThreadWebhookClaims = {
  version: 1,
  kind: "thread-webhook",
  hookId: "hook-1",
  threadId: ThreadId.make("thread-1"),
  expiresAt: 2_000,
};

describe("ThreadWebhook", () => {
  it("signs thread-bound claims and rejects tampering or expiry", () => {
    const token = encodeThreadWebhookToken(claims, secret);

    expect(decodeThreadWebhookToken(token, secret, 1_999)).toEqual(claims);
    expect(decodeThreadWebhookToken(token, secret, 2_000)).toBeNull();
    expect(decodeThreadWebhookToken(`${token}x`, secret, 1_999)).toBeNull();
    expect(
      decodeThreadWebhookToken(
        token,
        new TextEncoder().encode("another-32-byte-signing-secret!!"),
        1_999,
      ),
    ).toBeNull();
  });

  it("accepts only an HTTP(S) origin when building an external URL", () => {
    const relative = "/api/orchestration/hooks/token.signature";

    expect(resolveThreadWebhookUrl(relative, undefined)).toBe(relative);
    expect(resolveThreadWebhookUrl(relative, "https://t3.example.test")).toBe(
      "https://t3.example.test/api/orchestration/hooks/token.signature",
    );
    expect(resolveThreadWebhookUrl(relative, "ftp://t3.example.test")).toBeNull();
    expect(resolveThreadWebhookUrl(relative, "https://user:t@t3.example.test")).toBeNull();
    expect(resolveThreadWebhookUrl(relative, "https://t3.example.test/base/")).toBeNull();
    expect(resolveThreadWebhookUrl(relative, "https://t3.example.test/?token=x")).toBeNull();
  });

  it("marks callback content as untrusted and bounds its size", () => {
    const formatted = formatThreadWebhookCallbackText("build finished");
    expect(formatted).toBe(
      "[External webhook callback — untrusted data]\n\nbuild finished",
    );

    const oversized = formatThreadWebhookCallbackText("x".repeat(20_100));
    expect(Array.from(oversized.split("\n\n")[1] ?? "")).toHaveLength(20_000);
  });
});
