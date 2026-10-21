import { useCallback, useEffect, useRef, useState } from "react";

import { fetchSessionRoute, type SessionRouteInfo } from "../lib/sessionRoute";

/** 本机模型网关地址。手机端需通过内网/SSH 隧道指向可达的网关地址。 */
const DEFAULT_BASE_URL = "http://127.0.0.1:4010";

export interface UseSessionModelRouteInput {
  /** 会话的 providerSessionId；为 null 时不查询。 */
  readonly sessionId: string | null;
  readonly enabled: boolean;
  readonly baseUrl?: string | null;
  /** 变更时触发重新查询（如最新 turnId 变化，表示新消息已发送）。 */
  readonly trigger?: string | number | null;
}

export interface UseSessionModelRouteReturn {
  readonly info: SessionRouteInfo | null;
  readonly error: Error | null;
  readonly isLoading: boolean;
  /** 手动刷新（例如用户点击指示器）。 */
  readonly refresh: () => Promise<void>;
}

export function useSessionModelRoute(input: UseSessionModelRouteInput): UseSessionModelRouteReturn {
  const { sessionId, enabled, baseUrl, trigger } = input;
  const [info, setInfo] = useState<SessionRouteInfo | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled || !sessionId) {
      setInfo(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    cancel();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    setError(null);
    try {
      const next = await fetchSessionRoute(sessionId, {
        baseUrl,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setInfo(next ?? null);
      setError(next ? null : new Error("模型路由信息暂不可用"));
    } catch (err) {
      if (controller.signal.aborted) return;
      setInfo(null);
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (!controller.signal.aborted) {
        setIsLoading(false);
      }
    }
  }, [sessionId, enabled, baseUrl, cancel]);

  // 会话切换、开关变更或新消息（trigger）后自动刷新。
  useEffect(() => {
    void refresh();
  }, [sessionId, enabled, trigger, refresh]);

  useEffect(() => {
    return cancel;
  }, [cancel]);

  return { info, error, isLoading, refresh };
}

export { DEFAULT_BASE_URL };
