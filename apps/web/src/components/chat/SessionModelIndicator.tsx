import { formatSessionRouteLabel, type SessionRouteInfo } from "@/lib/sessionRoute";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

interface SessionModelIndicatorProps {
  readonly info: SessionRouteInfo | null;
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly onRefresh?: () => void;
  readonly className?: string;
}

/**
 * 显示当前会话实际使用的模型（provider/model 和档位）。
 * 失败或加载中时显示占位符，点击可刷新。
 */
export function SessionModelIndicator({
  info,
  isLoading,
  error,
  onRefresh,
  className,
}: SessionModelIndicatorProps) {
  const label = info ? formatSessionRouteLabel(info) : null;
  const showPlaceholder = !label || isLoading;

  const handleClick = () => {
    if (onRefresh) {
      void onRefresh();
    }
  };

  if (showPlaceholder) {
    if (isLoading) {
      return <span className={cn("text-xs text-muted-foreground", className)}>加载中...</span>;
    }
    if (error) {
      return (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={handleClick}
                className={cn(
                  "text-xs text-muted-foreground hover:text-foreground cursor-pointer",
                  className,
                )}
                aria-label="模型信息不可用，点击重试"
              />
            }
          >
            模型信息不可用
          </TooltipTrigger>
          <TooltipPopup side="bottom">{error.message || "无法获取模型路由信息"}</TooltipPopup>
        </Tooltip>
      );
    }
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={handleClick}
            className={cn(
              "text-xs text-muted-foreground hover:text-foreground cursor-pointer transition-colors",
              className,
            )}
            aria-label={`当前模型: ${label}`}
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <div className="space-y-1">
          <div className="font-medium">当前模型</div>
          <div className="text-xs text-muted-foreground">
            {info?.provider}/{info?.model}
          </div>
          <div className="text-xs text-muted-foreground">档位: {info?.tier}</div>
          {info?.tier !== info?.baseTier && (
            <div className="text-xs text-muted-foreground">基础档位: {info?.baseTier}</div>
          )}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
