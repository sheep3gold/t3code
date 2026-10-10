// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { factoryApiKeyFingerprint, makeFactoryApiKeyResolver } from "./factoryApiKey.ts";

const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "factory-key-"));
const bootstrapPath = NodePath.join(dir, "bootstrap.env");
NodeFS.writeFileSync(
  bootstrapPath,
  "ETCD_ENDPOINT=https://etcd.test/etcd\nETCD_BASIC_USER=u\nETCD_BASIC_PASS=p\n",
);

const etcdReply = (value: string | null) =>
  new Response(
    JSON.stringify(
      value === null ? {} : { kvs: [{ value: Buffer.from(value).toString("base64") }] },
    ),
  );

describe("factory API key resolver", () => {
  it.effect("passes the base environment through when no etcd key is configured", () =>
    Effect.gen(function* () {
      const resolver = makeFactoryApiKeyResolver({ etcdKey: "", baseEnvironment: { A: "1" } });
      expect(yield* resolver.environment).toEqual({
        A: "1",
        HTTPS_PROXY: "http://127.0.0.1:2080",
      });
    }),
  );

  it.effect("reads the key from etcd and picks up a rotation after the cache expires", () =>
    Effect.gen(function* () {
      let value = "key-one";
      let clock = 0;
      const requests: Array<{ url: string; body: string }> = [];
      const resolver = makeFactoryApiKeyResolver({
        etcdKey: "/droid/appkey",
        baseEnvironment: { FACTORY_API_KEY: "from-env" },
        bootstrapPath,
        ttlMs: 5_000,
        now: () => clock,
        fetchImpl: (async (url: string, init: RequestInit) => {
          requests.push({ url, body: String(init.body) });
          return etcdReply(value);
        }) as unknown as typeof fetch,
      });
      const read = () =>
        Effect.map(resolver.environment, (environment) => environment.FACTORY_API_KEY);
      expect(yield* read()).toBe("key-one");
      value = "key-two";
      clock = 4_000;
      expect(yield* read()).toBe("key-one");
      expect(requests).toHaveLength(1);
      clock = 6_000;
      expect(yield* read()).toBe("key-two");
      expect(requests[0]).toEqual({
        url: "https://etcd.test/etcd/v3/kv/range",
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        body: JSON.stringify({ key: Buffer.from("/droid/appkey").toString("base64") }),
      });
    }),
  );

  it.effect("falls back to the last known key, then to the environment, when etcd fails", () =>
    Effect.gen(function* () {
      let fail = false;
      let clock = 0;
      const make = (env: NodeJS.ProcessEnv) =>
        makeFactoryApiKeyResolver({
          etcdKey: "/droid/appkey",
          baseEnvironment: env,
          bootstrapPath,
          ttlMs: 1,
          now: () => (clock += 10),
          fetchImpl: (async () => {
            if (fail) throw new Error("network down");
            return etcdReply("etcd-key");
          }) as unknown as typeof fetch,
        });
      const read = (resolver: ReturnType<typeof make>) =>
        Effect.map(resolver.environment, (environment) => environment.FACTORY_API_KEY);
      const warm = make({});
      expect(yield* read(warm)).toBe("etcd-key");
      fail = true;
      expect(yield* read(warm)).toBe("etcd-key");
      expect(yield* read(make({ FACTORY_API_KEY: "from-env" }))).toBe("from-env");
    }),
  );

  it("fingerprints keys without exposing them", () => {
    const print = factoryApiKeyFingerprint({ FACTORY_API_KEY: "secret-value" });
    expect(print).toMatch(/^[0-9a-f]{16}$/);
    expect(print).not.toContain("secret");
    expect(factoryApiKeyFingerprint({})).toBe("");
  });
});
