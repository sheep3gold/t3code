import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

interface SessionModelIndicatorProps {
  /** `provider/model` as the model gateway reports it, e.g. `minimax/MiniMax-M3.1-Flash`. */
  readonly model: string;
  readonly className?: string;
}

/** 选 auto 时显示最近一次请求实际落到的模型（网关在响应里报的 provider/模型）。 */
export function SessionModelIndicator({ model, className }: SessionModelIndicatorProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn("max-w-64 truncate text-xs text-muted-foreground", className)}
            aria-label={`auto 实际模型: ${model}`}
          />
        }
      >
        auto → {model}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <div className="space-y-1">
          <div className="font-medium">auto 实际模型</div>
          <div className="text-xs text-muted-foreground">{model}</div>
          <div className="text-xs text-muted-foreground">
            按最近一次请求更新，降级换模型时会跟着变
          </div>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
