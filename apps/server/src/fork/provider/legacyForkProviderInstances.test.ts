import { describe, expect, it } from "@effect/vitest";

import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import * as Schema from "effect/Schema";

import {
  FACTORY_DROID_ACP_WRAPPER,
  migrateLegacyForkProviderInstancesJson,
} from "./legacyForkProviderInstances.ts";

const decodeAcpSettings = Schema.decodeUnknownSync(AcpRegistrySettings);

const migrate = (providerInstances: Record<string, unknown>) =>
  JSON.parse(migrateLegacyForkProviderInstancesJson(JSON.stringify({ providerInstances })))
    .providerInstances;

describe("legacy fork provider instances", () => {
  it("runs Kiro as a local ACP agent with the configured engine and agent", () => {
    const { kiro } = migrate({
      kiro: {
        driver: "kiro",
        enabled: true,
        config: { binaryPath: "kiro-cli", agentEngine: "v2", agent: "t3", customModels: ["glm-5"] },
      },
    });
    expect(kiro.driver).toBe("acpRegistry");
    expect(kiro.enabled).toBe(true);
    expect(decodeAcpSettings(kiro.config)).toMatchObject({
      source: "local",
      commandPath: "kiro-cli",
      commandArgs: ["acp", "--agent-engine", "v2", "--agent", "t3"],
      customModels: ["glm-5"],
    });
  });

  it("runs Factory through the etcd-aware wrapper without copying the key", () => {
    const { factory } = migrate({
      factory: {
        driver: "factory",
        displayName: "Factory Droid",
        config: { binaryPath: "/bin/droid", apiKeyEtcdKey: "/droid/appkey" },
      },
    });
    expect(factory.config.commandPath).toBe(FACTORY_DROID_ACP_WRAPPER);
    expect(factory.config.authMethodId).toBe("factory-api-key");
    expect(factory.environment).toEqual([
      { name: "T3_FACTORY_DROID_BIN", value: "/bin/droid", sensitive: false },
      { name: "T3_FACTORY_API_KEY_ETCD_KEY", value: "/droid/appkey", sensitive: false },
    ]);
  });

  it("keeps an explicit environment variable over the migrated default", () => {
    const { minimax } = migrate({
      minimax: {
        driver: "minimax",
        environment: [{ name: "MINIMAX_DATA_DIR", value: "/custom", sensitive: false }],
        config: { binaryPath: "mcode", dataDir: "/from-config" },
      },
    });
    expect(minimax.config.commandArgs).toEqual(["acp"]);
    expect(minimax.environment).toEqual([
      { name: "MINIMAX_DATA_DIR", value: "/custom", sensitive: false },
    ]);
  });

  it("leaves settings without fork drivers byte-for-byte unchanged", () => {
    const raw = '{"providerInstances":{"codex":{"driver":"codex"}}}';
    expect(migrateLegacyForkProviderInstancesJson(raw)).toBe(raw);
    expect(migrateLegacyForkProviderInstancesJson("{not json")).toBe("{not json");
  });
});
