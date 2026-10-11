import { createMcpAppEnvironmentAtoms } from "@t3tools/client-runtime/state/mcp-apps";

import { connectionAtomRuntime } from "../connection/runtime";

/** RPC commands an MCP App host makes on an app's behalf, like web's. */
export const mcpAppEnvironment = createMcpAppEnvironmentAtoms(connectionAtomRuntime);
