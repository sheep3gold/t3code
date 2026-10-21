import { useCallback, useEffect, useState } from "react";
import { useReadApi } from "../state/use-read-api";
import { WS_METHODS } from "@t3tools/contracts";
import { type ServerModelRouteInfo } from "@t3tools/contracts";

export interface UseSessionModelRouteInput {
  /** 会话的 providerSessionId；为 null 时不查询。 */
  readonly sessionId: string | null;
  readonly enabled: boolean;
  /** 变更时触发重新查询（如最新 turnId 变化，表示新消息已发送）。 */
  readonly trigger?: string | number | null;
}

export interface UseSessionModelRouteReturn {
  readonly info: ServerModelRouteInfo | null;
  readonly error: Error | null;
  readonly isLoading: boolean;
  /** 手动刷新（例如用户点击指示器）。 */
  readonly refresh: () => Promise<void>;
}

export function useSessionModelRoute(input: UseSessionModelRouteInput): UseSessionModelRouteReturn {
  const { sessionId, enabled, trigger } = input;
  const [info, setInfo] = useState<ServerModelRouteInfo | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled || !sessionId) {
      setInfo(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const api = useReadApi();
      const result = await api.call(WS_METHODS.serverGetModelRoute, {
        providerSessionId: sessionId,
      });
      setInfo(result);
    } catch (err) {
      setInfo(null);
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [sessionId, enabled]);

  // 会话切换、开关变更或新消息（trigger）后自动刷新。
  useEffect(() => {
    void refresh();
  }, [sessionId, enabled, trigger, refresh]);

  return { info, error, isLoading, refresh };
}
