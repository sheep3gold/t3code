import { useEnvironmentQuery } from "../state/query";
import {
  WS_METHODS,
  type OrchestrationV2ThreadProjection,
  type EnvironmentId,
} from "@t3tools/contracts";
import { type ServerModelRouteInfo } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export interface UseSessionModelRouteInput {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string | null;
  readonly enabled: boolean;
  /** 变更时触发重新查询（如最新 turnId 变化，表示新消息已发送）。 */
  readonly trigger?: string | number | null | undefined;
}

export interface UseSessionModelRouteReturn {
  readonly info: ServerModelRouteInfo | null;
  readonly error: Error | null;
  readonly isLoading: boolean;
  /** 手动刷新（例如用户点击指示器）。 */
  readonly refresh: () => void;
}

/**
 * 从 thread projection 中提取活跃 provider thread 的 providerSessionId。
 */
export function extractProviderSessionId(
  projection: OrchestrationV2ThreadProjection | null,
): string | null {
  if (!projection) return null;
  const activeProviderThreadId = projection.thread.activeProviderThreadId;
  if (!activeProviderThreadId) return null;
  const activeProviderThread = projection.providerThreads.find(
    (pt) => pt.id === activeProviderThreadId,
  );
  return activeProviderThread?.providerSessionId ?? null;
}

// Query atom family for model route RPC
const modelRouteQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:model-route",
  tag: WS_METHODS.serverGetModelRoute,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});

export function useSessionModelRoute(input: UseSessionModelRouteInput): UseSessionModelRouteReturn {
  const { environmentId, sessionId, enabled, trigger } = input;
  const atom =
    enabled && sessionId !== null
      ? modelRouteQuery({
          environmentId,
          input: { providerSessionId: sessionId },
        })
      : null;
  const query = useEnvironmentQuery(atom);
  const info = query.data as ServerModelRouteInfo | null;
  const error = query.error ? new Error(query.error) : null;
  const isLoading = query.isPending;

  const refresh = () => {
    query.refresh();
  };

  return { info, error, isLoading, refresh };
}
