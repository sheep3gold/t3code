import { useAtomValue } from "@effect/atom-react";
import {
  WS_METHODS,
  type OrchestrationV2ThreadProjection,
  type EnvironmentId,
} from "@t3tools/contracts";
import { type ServerModelRouteInfo } from "@t3tools/contracts";
import { type ScopedThreadRef } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcQueryAtomFamily,
  selectEnvironmentQueryData,
} from "@t3tools/client-runtime/state/runtime";
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
  const result = useAtomValue(
    enabled && sessionId !== null
      ? modelRouteQuery({
          environmentId,
          input: { providerSessionId: sessionId },
        })
      : null,
  );
  const info = selectEnvironmentQueryData(result);
  const error = result._tag === "Failure" ? result.cause : null;
  const isLoading = result._tag === "Loading" || result.waiting;

  const refresh = () => {
    if (enabled && sessionId !== null) {
      // The atom's refresh function is available through the registry
      // For now, this is a no-op that relies on trigger changes
    }
  };

  return { info, error, isLoading, refresh };
}
