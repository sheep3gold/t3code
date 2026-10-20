import { afterEach, expect, it, vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Etag, HttpClient, HttpClientResponse, HttpPlatform, HttpRouter } from "effect/http";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as TranslationHttp from "./http.ts";

afterEach(() => vi.unstubAllEnvs());

async function translate(
  options: {
    body?: string;
    auth?: "allowed" | "missing" | "read-only";
    configured?: boolean;
    malformed?: boolean;
    fail?: boolean;
  } = {},
) {
  vi.stubEnv(
    "T3CODE_TRANSLATE_API_KEY",
    options.configured === false ? "" : "test-translation-key",
  );
  vi.stubEnv("T3CODE_TRANSLATE_BASE_URL", "https://translation.example.test/v1");
  const upstreamInputs: Array<ReadonlyArray<string>> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      expect(request.headers.authorization).toBe("Bearer test-translation-key");
      expect(request.headers["x-mg-tier"]).toBeUndefined();
      expect(request.url).toBe("https://translation.example.test/v1/chat/completions");
      if (request.body._tag !== "Uint8Array") throw new Error("Expected a JSON request body");
      const payload = JSON.parse(new TextDecoder().decode(request.body.body));
      const texts: string[] = JSON.parse(payload.messages[1].content);
      upstreamInputs.push(texts);
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: options.malformed
                    ? "not JSON"
                    : JSON.stringify(texts.map((text) => text.replaceAll("Hello", "你好"))),
                },
              },
            ],
          }),
          { status: options.fail ? 503 : 200, headers: { "content-type": "application/json" } },
        ),
      );
    }),
  );
  const routes = TranslationHttp.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        authenticateWebSocketUpgrade: () =>
          options.auth === "missing"
            ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}))
            : Effect.succeed({
                sessionId: AuthSessionId.make("translation-test"),
                subject: "test",
                method: "bearer-access-token",
                scopes: options.auth === "read-only" ? [] : ["orchestration:operate"],
              }),
      }),
    ),
    Layer.provide(HttpPlatform.layer),
    Layer.provide(Etag.layerWeak),
    Layer.provide(NodeServices.layer),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  try {
    const response = await handler(
      new Request("http://localhost/api/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: options.body ?? JSON.stringify({ texts: ["Hello `code`", "already"] }),
      }),
    );
    return { status: response.status, text: await response.text(), upstreamInputs };
  } finally {
    await dispose();
  }
}

it("routes translation through the authenticated service without exposing the upstream credential", async () => {
  const result = await translate();
  expect(result.status).toBe(200);
  expect(JSON.parse(result.text)).toEqual({ translations: ["你好 `code`", "already"] });
  expect(result.text).not.toContain("test-translation-key");
});

it.each(["missing", "read-only"] as const)(
  "rejects %s credentials before reading malformed input or calling upstream",
  async (auth) => {
    const result = await translate({ auth, body: "not-json" });
    expect(result.status).toBe(auth === "missing" ? 401 : 403);
    expect(result.upstreamInputs).toHaveLength(0);
  },
);

it("returns unavailable without making an upstream request when unconfigured", async () => {
  const result = await translate({ configured: false });
  expect(result.status).toBe(503);
  expect(result.upstreamInputs).toHaveLength(0);
});

it("splits and rejoins a long message without changing paragraph or code structure", async () => {
  const text = Array(8).fill("Hello ".repeat(150)).join("\n\n") + "\n\n`code`";
  const result = await translate({ body: JSON.stringify({ texts: [text] }) });
  expect(result.status).toBe(200);
  expect(JSON.parse(result.text)).toEqual({ translations: [text.replaceAll("Hello", "你好")] });
  expect(result.upstreamInputs.length).toBeGreaterThan(1);
});

it("bounds malformed-response recovery and returns a controlled error", async () => {
  const result = await translate({ malformed: true });
  expect(result.status).toBe(502);
  expect(result.upstreamInputs.length).toBeLessThanOrEqual(20);
  expect(result.text).not.toContain("test-translation-key");
});

it("rejects oversized input before contacting the translation gateway", async () => {
  const result = await translate({ body: JSON.stringify({ texts: ["x".repeat(16001)] }) });
  expect(result.status).toBe(502);
  expect(result.upstreamInputs).toHaveLength(0);
});

it("maps upstream failure to a controlled HTTP response", async () => {
  const result = await translate({ fail: true });
  expect(result.status).toBe(502);
  expect(result.upstreamInputs).toHaveLength(1);
  expect(result.text).not.toContain("test-translation-key");
});
