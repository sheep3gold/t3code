/**
 * `[OPTIONS: a | b | c]` 的解析与渲染。
 *
 * 这是 KiroCrew 约定的收尾标记：agent 在回复末尾给出几个候选动作。T3 原本不
 * 认识它，整行按普通文本显示成 `[OPTIONS: ... | ... ]`，既难读也点不了。
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
 *
 * @module components/chat/AssistantOptionChips
 */
import { ArrowUpIcon } from "lucide-react";

/** 行首到行尾恰好是一个 OPTIONS 标记。大小写不敏感，方便手写。 */
const OPTIONS_LINE = /^\s*\[OPTIONS:\s*([^\]]+)\]\s*$/i;

/** 候选之间、以及候选与用户自己输入之间的分隔。 */
const BLOCK_SEPARATOR = "\n\n";

export interface ParsedAssistantOptions {
  /** 去掉标记行之后的正文，交给原来的 markdown 渲染。 */
  readonly body: string;
  /** 标记里的候选项，已去空白与去重，保持原顺序。 */
  readonly options: ReadonlyArray<string>;
}

/**
 * 从助手正文尾部摘出 OPTIONS 标记。
 *
 * 没有标记、或一个候选都没有时返回 null——调用方据此原样渲染整段 markdown，
 * 宁可显示成字面量也不要把正文吃掉。
 */
export function parseAssistantOptions(text: string): ParsedAssistantOptions | null {
  if (!text.includes("[OPTIONS:") && !text.includes("[options:")) return null;

  const lines = text.split("\n");
  let lastIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if ((lines[i] ?? "").trim().length > 0) {
      lastIndex = i;
      break;
    }
  }
  if (lastIndex < 0) return null;

  const match = OPTIONS_LINE.exec(lines[lastIndex] ?? "");
  if (match === null) return null;

  const seen = new Set<string>();
  const options: string[] = [];
  for (const raw of (match[1] ?? "").split("|")) {
    const label = raw.trim();
    if (label.length === 0 || seen.has(label)) continue;
    seen.add(label);
    options.push(label);
  }
  if (options.length === 0) return null;

  return { body: lines.slice(0, lastIndex).join("\n").trimEnd(), options };
}

/** 输入框内容里是否已含这一条候选（按块比对，避免匹配到用户正文里的巧合子串）。 */
export function isOptionSelected(prompt: string, label: string): boolean {
  return prompt.split(BLOCK_SEPARATOR).some((block) => block.trim() === label);
}

/**
 * 切换一条候选在输入框里的存在。
 *
 * 已存在 → 移除那一块；不存在 → 追加到末尾。按块操作而不是子串替换，
 * 这样用户自己打的文字不会被误伤。
 */
export function toggleOptionInPrompt(prompt: string, label: string): string {
  const blocks = prompt.split(BLOCK_SEPARATOR);
  const kept = blocks.filter((block) => block.trim() !== label);

  if (kept.length !== blocks.length) {
    // 撤销：顺带清掉移除后可能留下的空块，避免输入框顶部多出空行。
    return kept
      .filter((block, index) => block.trim().length > 0 || index < kept.length - 1)
      .join(BLOCK_SEPARATOR)
      .replace(/^\s+/, "")
      .trimEnd();
  }

  const base = prompt.trimEnd();
  return base.length === 0 ? label : `${base}${BLOCK_SEPARATOR}${label}`;
}

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
        return (
          <div
            key={label}
            className={[
              "inline-flex items-stretch overflow-hidden rounded-full border text-xs transition-colors",
              selected ? "border-primary bg-accent/60" : "border-border bg-muted/30",
              disabled ? "opacity-50" : "",
            ].join(" ")}
          >
            <button
              type="button"
              disabled={disabled}
              onClick={() => onToggle(label)}
              aria-pressed={selected}
              title={selected ? "点一下撤销" : "加入输入框"}
              className={[
                "max-w-[26rem] truncate px-3 py-1 text-left",
                selected ? "text-foreground" : "text-muted-foreground",
                disabled ? "cursor-not-allowed" : "cursor-pointer hover:text-foreground",
              ].join(" ")}
            >
              {label}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSend(label)}
              title="只发送这一条"
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
          </div>
        );
      })}
    </div>
  );
}
