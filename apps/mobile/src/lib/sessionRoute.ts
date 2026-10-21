/**
 * 模型网关会话路由查询。
 *
 * 通过 WebSocket RPC 的 server.getModelRoute 方法查询模型网关。
 * 后端会代理到网关的 /session/by-id/{session_id} 端点。
 *
 * 返回：{ sessionKey, tier, baseTier, provider, model, deployment, lastStatus, ts }
 */

export interface SessionRouteInfo {
  readonly sessionKey: string;
  readonly tier: string;
  readonly baseTier: string;
  readonly provider: string;
  readonly model: string;
  readonly deployment: string;
  readonly lastStatus: string;
  readonly ts: number;
}

/** 显示文本：glm/glm-5.3 (MEDIUM档) */
export function formatSessionRouteLabel(input: {
  readonly provider: string;
  readonly model: string;
  readonly tier: string;
}): string {
  const { provider, model, tier } = input;
  const section = provider && model ? `${provider}/${model}` : "";
  return tier ? `${section} (${tier}档)` : section;
}
