const OPTIONS_LINE = /^\s*\[OPTIONS:\s*([^\]]+)\]\s*$/i;
const BLOCK_SEPARATOR = "\n\n";

export interface ParsedAssistantOptions {
  readonly body: string;
  readonly options: ReadonlyArray<string>;
}

export function parseAssistantOptions(text: string): ParsedAssistantOptions | null {
  if (!text.includes("[OPTIONS:") && !text.includes("[options:")) return null;

  const lines = text.split("\n");
  let lastIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? "").trim().length > 0) {
      lastIndex = index;
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

export function isOptionSelected(prompt: string, label: string): boolean {
  return prompt.split(BLOCK_SEPARATOR).some((block) => block.trim() === label);
}

export function toggleOptionInPrompt(prompt: string, label: string): string {
  const blocks = prompt.split(BLOCK_SEPARATOR);
  const kept = blocks.filter((block) => block.trim() !== label);

  if (kept.length !== blocks.length) {
    return kept
      .filter((block, index) => block.trim().length > 0 || index < kept.length - 1)
      .join(BLOCK_SEPARATOR)
      .replace(/^\s+/, "")
      .trimEnd();
  }

  const base = prompt.trimEnd();
  return base.length === 0 ? label : `${base}${BLOCK_SEPARATOR}${label}`;
}
