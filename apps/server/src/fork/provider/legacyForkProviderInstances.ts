/**
 * The V1 fork shipped its own `kiro`, `factory` and `minimax` drivers. All
 * three are ACP agents, which upstream's `acpRegistry` driver runs as a local
 * command, so their instances are rewritten to that driver before settings
 * decode. Instance ids are kept, so threads bound to them keep routing.
 */

// Installed by deploy/host/install-host.sh. It reads the Droid API key from
// etcd on every spawn and routes Droid's egress through the configured proxy.
export const FACTORY_DROID_ACP_WRAPPER = "t3-factory-droid-acp";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const environmentList = (value: unknown): Array<JsonRecord> =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const withVariables = (
  environment: unknown,
  variables: ReadonlyArray<readonly [string, string | undefined]>,
): Array<JsonRecord> => {
  const list = environmentList(environment);
  for (const [name, value] of variables) {
    if (value === undefined || list.some((entry) => entry.name === name)) continue;
    list.push({ name, value, sensitive: false });
  }
  return list;
};

const acpLocal = (
  instance: JsonRecord,
  input: {
    readonly displayName: string;
    readonly commandPath: string;
    readonly commandArgs: ReadonlyArray<string>;
    readonly customModels: ReadonlyArray<string>;
    readonly authMethodId?: string;
    readonly environment: Array<JsonRecord>;
  },
): JsonRecord => ({
  ...instance,
  driver: "acpRegistry",
  displayName: text(instance.displayName) ?? input.displayName,
  ...(input.environment.length > 0 ? { environment: input.environment } : {}),
  config: {
    source: "local",
    commandPath: input.commandPath,
    commandArgs: input.commandArgs,
    customModels: input.customModels,
    ...(input.authMethodId ? { authMethodId: input.authMethodId } : {}),
  },
});

export function migrateLegacyForkProviderInstance(instance: JsonRecord): JsonRecord {
  const config = isRecord(instance.config) ? instance.config : {};
  const customModels = strings(config.customModels);
  switch (instance.driver) {
    case "kiro": {
      const agent = text(config.agent);
      return acpLocal(instance, {
        displayName: "Kiro",
        commandPath: text(config.binaryPath) ?? "kiro-cli",
        commandArgs: [
          "acp",
          "--agent-engine",
          text(config.agentEngine) ?? "v2",
          ...(agent ? ["--agent", agent] : []),
        ],
        customModels,
        environment: environmentList(instance.environment),
      });
    }
    case "factory":
      return acpLocal(instance, {
        displayName: "Factory Droid",
        commandPath: FACTORY_DROID_ACP_WRAPPER,
        commandArgs: [],
        customModels,
        ...(text(config.apiKeyEtcdKey) ? { authMethodId: "factory-api-key" } : {}),
        environment: withVariables(instance.environment, [
          ["T3_FACTORY_DROID_BIN", text(config.binaryPath)],
          ["T3_FACTORY_API_KEY_ETCD_KEY", text(config.apiKeyEtcdKey)],
          ["T3_FACTORY_PROXY_URL", text(config.proxyUrl)],
        ]),
      });
    case "minimax":
      return acpLocal(instance, {
        displayName: "MiniMax Code",
        commandPath: text(config.binaryPath) ?? "mcode",
        commandArgs: ["acp"],
        customModels,
        environment: withVariables(instance.environment, [
          ["MINIMAX_DATA_DIR", text(config.dataDir)],
        ]),
      });
    default:
      return instance;
  }
}

/** Rewrites raw settings.json text; anything unparseable is left to the real decoder. */
export function migrateLegacyForkProviderInstancesJson(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!isRecord(parsed) || !isRecord(parsed.providerInstances)) return raw;
  let changed = false;
  const providerInstances: JsonRecord = {};
  for (const [id, instance] of Object.entries(parsed.providerInstances)) {
    const migrated = isRecord(instance) ? migrateLegacyForkProviderInstance(instance) : instance;
    if (migrated !== instance) changed = true;
    providerInstances[id] = migrated;
  }
  return changed ? JSON.stringify({ ...parsed, providerInstances }, null, 2) : raw;
}
