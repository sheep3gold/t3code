import { upgradeLegacyContextMessage } from "./composerContextLegacy.ts";
import { parseComposerContextHref } from "./composerContextReferences.ts";
import { parseAssistantCitationHref } from "./assistantCitations.ts";
import type { AssistantCitation } from "@t3tools/contracts";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";

// Inline wrappers (including Shiki token spans) must not split a search phrase.
export const THREAD_FIND_BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

const assistantProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw);
const assistantBreaksProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkBreaks)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw);
const userProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkBreaks)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw);

interface TextTree {
  readonly type: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly properties?: {
    readonly href?: unknown;
    readonly src?: unknown;
  };
  readonly children?: ReadonlyArray<TextTree>;
}

export interface ThreadFindMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly streaming?: boolean;
  /** Present when `text` is already free of legacy context blocks. */
  readonly hasContext?: boolean;
}

/** Mirrors the web renderer's "★ Insight" line-break rule. */
function shouldPreserveAssistantLineBreaks(text: string): boolean {
  return /^★ Insight(?:\s|─)/mu.test(text);
}

/** The citation chip shows the comment when present, otherwise the quoted text. */
function citationChipLabel(citation: AssistantCitation): string {
  return (citation.comment?.trim() || citation.text).replace(/\s+/g, " ");
}

/** Uses the renderer's Markdown transforms, without mounting folded/virtualized rows. */
function markdownThreadFindText(
  markdown: string,
  userMessage = false,
  lineBreaks = false,
  skipContextReferences = userMessage,
): string[] {
  const processor = userMessage
    ? userProcessor
    : lineBreaks
      ? assistantBreaksProcessor
      : assistantProcessor;
  const tree = processor.runSync(processor.parse(markdown)) as unknown as TextTree;
  const segments: string[] = [];
  let text = "";
  const flush = () => {
    if (text.trim()) segments.push(text);
    text = "";
  };
  const visit = (node: TextTree, inPre = false): void => {
    const href = node.properties?.href ?? node.properties?.src;
    if (skipContextReferences && typeof href === "string" && parseComposerContextHref(href)) {
      // Context chips render as standalone tokens; a search phrase must not
      // join prose across a chip. Plans render markdown literally, so they
      // keep the reference label text instead.
      flush();
      return;
    }
    const citation =
      node.tagName === "a" && typeof href === "string" ? parseAssistantCitationHref(href) : null;
    if (citation) {
      // Matches the citation chip, which shows its label instead of the link text.
      text += citationChipLabel(citation);
      return;
    }
    const block = THREAD_FIND_BLOCK_TAGS.has(node.tagName ?? "");
    if (block) flush();
    if (node.type === "text" || (userMessage && node.type === "raw")) {
      text += inPre ? (node.value ?? "") : (node.value ?? "").replace(/\r?\n/g, " ");
    }
    for (const child of node.children ?? []) visit(child, inPre || node.tagName === "pre");
    if (block) flush();
  };
  visit(tree);
  flush();
  return segments;
}

/** Plans render their markdown literally, so they are indexed as written. */
export function searchablePlanSegments(markdown: string): readonly string[] {
  return markdownThreadFindText(markdown, false, false);
}

// Legacy context blocks that could not be upgraded stay in the stored text, but
// the web renderer's sanitize step hides those tags; the find index mirrors
// what is visible, so they are removed before parsing.
const HIDDEN_LEGACY_CONTEXT_BLOCKS =
  /^<(?:terminal_context|element_context|preview_annotation)>\n[\s\S]*?\n<\/(?:terminal_context|element_context|preview_annotation)>/gm;

export function searchableMessageSegments(message: ThreadFindMessage): readonly string[] | null {
  if (message.role === "user") {
    if (message.hasContext) {
      // Structured context is rendered from records; literal legacy tags in the
      // text are not upgraded and stay visible verbatim.
      return markdownThreadFindText(message.text, true, true);
    }
    const upgraded = upgradeLegacyContextMessage(message.text).text;
    const text = upgraded.replace(HIDDEN_LEGACY_CONTEXT_BLOCKS, "");
    return markdownThreadFindText(text, true, true);
  }
  if (message.role !== "assistant") return null;
  return markdownThreadFindText(
    message.text || (message.streaming ? "" : "(empty response)"),
    false,
    shouldPreserveAssistantLineBreaks(message.text),
  );
}
