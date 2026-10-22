/**
 * `[OPTIONS: a | b | c]` 的解析与 chip 候选的可见性。
 *
 * 这是 KiroCrew 约定的收尾标记：agent 在回复末尾给出几个候选动作。T3 把它渲染成
 * 输入框上方的 chip，而不是留在消息气泡里——候选是「接下来要发什么」，它属于输入区
 * 而不属于历史记录；跟着消息滚走就点不到了。
 *
 * 候选只属于给出它们的那一轮回复。用户一旦回话（点箭头发送还是自己打字），这一轮
 * 就结束了，候选随之作废：留着它们等于让用户对着上一轮的建议继续点。
 *
 * @module assistantOptions
 */

/** 标记行必须独占最后一行；大小写不敏感，方便手写。 */
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

/** 判定候选归属只需要时间线消息的这几项。 */
export interface AssistantOptionMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly streaming: boolean;
}

/** 还值得点的候选，以及它们出自哪一条回复。 */
export interface AssistantOptionSource {
  /** 给出候选的那条 assistant 消息。 */
  readonly messageId: string;
  readonly options: ReadonlyArray<string>;
}

/**
 * 找出当前仍然有效的候选。
 *
 * 从最新的消息往前看：先撞上用户消息说明用户已经回话，候选作废；先撞上 assistant
 * 消息就以它为准，但流式输出中的回复不能点——标记行可能还没写完，候选会跳。
 */
export function resolveActiveOptionSource(
  messages: ReadonlyArray<AssistantOptionMessage>,
): AssistantOptionSource | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.role === "user") return null;
    if (message.role !== "assistant") continue;
    if (message.streaming) return null;
    const options = parseAssistantOptions(message.text)?.options ?? [];
    return options.length === 0 ? null : { messageId: message.id, options };
  }
  return null;
}
