/**
 * `[OPTIONS: a | b | c]` 的解析与渲染。
 *
 * 这是 KiroCrew 约定的收尾标记：agent 在回复末尾给出几个候选动作，界面把它们
 * 渲染成可点的 chip。T3 原本不认识这个标记，于是整行按普通文本显示成
 * `[OPTIONS: ... | ... ]`，既难读也点不了。
 *
 * 交互与 KiroCrew 对齐：
 *   * 点 chip 本体      → 追加到输入框（可连点多个拼起来），不发送
 *   * 点 chip 右侧箭头  → 直接发送这一条
 *
 * 两件刻意的取舍：
 *   * 只认**最后一个非空行**上的标记。标记的语义是「这一轮的收尾选项」，
 *     正文中间偶然出现的同形文本不该变成按钮。
 *   * 解析失败时返回 null，调用方原样渲染整段 markdown。宁可显示成字面量，
 *     也不要把一段正文吃掉。
 *
 * @module components/chat/AssistantOptionChips
 */
import { ArrowUpIcon } from "lucide-react";

/** 行首到行尾恰好是一个 OPTIONS 标记。大小写不敏感，方便手写。 */
const OPTIONS_LINE = /^\s*\[OPTIONS:\s*([^\]]+)\]\s*$/i;

export interface ParsedAssistantOptions {
  /** 去掉标记行之后的正文，交给原来的 markdown 渲染。 */
  readonly body: string;
  /** 标记里的候选项，已去空白与去重，保持原顺序。 */
  readonly options: ReadonlyArray<string>;
}

/**
 * 从助手正文尾部摘出 OPTIONS 标记。
 *
 * 没有标记、标记为空、或只有一个空项时返回 null——一个候选项不构成选择，
 * 渲染成按钮反而让用户以为还有别的。
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

export interface AssistantOptionChipsProps {
  readonly options: ReadonlyArray<string>;
  /** 追加到输入框，不发送。 */
  readonly onAppend: (label: string) => void;
  /** 写入输入框并立即发送。 */
  readonly onSend: (label: string) => void;
  /** 会话忙时禁用，避免在上一轮还没收尾时插一条。 */
  readonly disabled?: boolean;
}

export function AssistantOptionChips({
  options,
  onAppend,
  onSend,
  disabled = false,
}: AssistantOptionChipsProps) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5" data-testid="assistant-option-chips">
      {options.map((label) => (
        <div
          key={label}
          className={[
            "group inline-flex items-stretch overflow-hidden rounded-full",
            "border border-border bg-muted/30",
            disabled ? "opacity-50" : "hover:border-border/80",
          ].join(" ")}
        >
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAppend(label)}
            // 追加而非发送：用户可能想连点几个凑一句话，或点完再补充。
            title="加入输入框"
            className={[
              "max-w-[28rem] truncate px-3 py-1 text-left text-xs text-foreground",
              disabled ? "cursor-not-allowed" : "cursor-pointer hover:bg-accent/40",
            ].join(" ")}
          >
            {label}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSend(label)}
            title="直接发送"
            aria-label={`直接发送：${label}`}
            className={[
              "flex items-center border-l border-border px-1.5 text-muted-foreground",
              disabled
                ? "cursor-not-allowed"
                : "cursor-pointer hover:bg-accent hover:text-foreground",
            ].join(" ")}
          >
            <ArrowUpIcon size={12} strokeWidth={2.5} />
          </button>
        </div>
      ))}
    </div>
  );
}
