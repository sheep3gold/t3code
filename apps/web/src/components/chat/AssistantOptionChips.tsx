/**
 * `[OPTIONS: a | b | c]` 的候选渲染。
 *
 * 渲染位置与 KiroCrew 一致：**贴在输入框上方**，而不是留在消息气泡里。候选是
 * 「接下来要发什么」，它属于输入区而不属于历史记录；跟着消息滚走就点不到了。
 *
 * 交互：
 *   * 点 chip 本体      → 追加到输入框；**再点同一个 → 撤销追加**（可切换）
 *   * 点 chip 右侧箭头  → 只发送这一条，不动输入框里已有的草稿
 *
 * 选中态直接从输入框内容推导，不另存一份 state。这样用户手动删掉那段文字，
 * chip 会自动回到未选中——两份真相同步不了的问题从根上不存在。
 */
import { ArrowUpIcon } from "lucide-react";

import { isOptionSelected } from "@t3tools/client-runtime/assistantOptions";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface AssistantOptionChipsProps {
  readonly options: ReadonlyArray<string>;
  /** 当前输入框内容，用于推导每个 chip 的选中态。 */
  readonly prompt: string;
  /** 点 chip 本体：追加或撤销。 */
  readonly onToggle: (label: string) => void;
  /** 点箭头：只发送这一条。 */
  readonly onSend: (label: string) => void;
  readonly disabled?: boolean;
}

export function AssistantOptionChips({
  options,
  prompt,
  onToggle,
  onSend,
  disabled = false,
}: AssistantOptionChipsProps) {
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-1.5" data-testid="assistant-option-chips">
      {options.map((label) => {
        const selected = isOptionSelected(prompt, label);
        const toggleButton = (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onToggle(label)}
            aria-pressed={selected}
            className={[
              "max-w-[26rem] truncate px-3 py-1 text-left",
              selected ? "text-foreground" : "text-muted-foreground",
              disabled ? "cursor-not-allowed" : "cursor-pointer hover:text-foreground",
            ].join(" ")}
          >
            {label}
          </button>
        );
        const sendButton = (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSend(label)}
            aria-label={`只发送这一条：${label}`}
            className={[
              "flex items-center border-l px-1.5",
              selected ? "border-primary/60" : "border-border",
              disabled
                ? "cursor-not-allowed"
                : "cursor-pointer text-muted-foreground hover:bg-accent hover:text-foreground",
            ].join(" ")}
          >
            <ArrowUpIcon size={12} strokeWidth={2.5} />
          </button>
        );
        return (
          <div
            key={label}
            className={[
              "inline-flex items-stretch overflow-hidden rounded-full border text-xs transition-colors",
              selected ? "border-primary bg-accent/60" : "border-border bg-muted/30",
              disabled ? "opacity-50" : "",
            ].join(" ")}
          >
            <Tooltip>
              <TooltipTrigger render={toggleButton} />
              <TooltipPopup side="top">{selected ? "点一下撤销" : "加入输入框"}</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger render={sendButton} />
              <TooltipPopup side="top">只发送这一条</TooltipPopup>
            </Tooltip>
          </div>
        );
      })}
    </div>
  );
}
