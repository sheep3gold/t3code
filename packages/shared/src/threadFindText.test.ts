import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { serializeAssistantCitation } from "./assistantCitations.ts";
import { formatComposerContextReference } from "./composerContextReferences.ts";
import { searchableMessageSegments, searchablePlanSegments } from "./threadFindText.ts";

it("excludes review attachments upgraded to context reference links", () => {
  const text = [
    "Before **review**",
    '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="hidden.ts" startIndex="3" endIndex="14" rangeLabel="L4">',
    "Keep **this literal** comment.",
    "```diff",
    "+ hidden patch content",
    "```",
    "</review_comment>",
    "After review",
  ].join("\n");
  expect(searchableMessageSegments({ role: "user", text, streaming: false })).toEqual([
    "Before review",
    " After review",
  ]);
});

it("keeps malformed review tags visible, matching the message renderer", () => {
  const text = "<review_comment>not a valid attachment</review_comment>";
  expect(searchableMessageSegments({ role: "user", text, streaming: false })).toEqual([text]);
});

it("excludes structured context chips without joining text across them", () => {
  expect(
    searchableMessageSegments({
      role: "user",
      streaming: false,
      hasContext: true,
      text: "before[hidden label](t3-context://v1/terminal/terminal_1)after",
    }),
  ).toEqual(["before", "after"]);
});

it("does not upgrade literal legacy tags when context is already structured", () => {
  const text =
    "<terminal_context>\n- Terminal 1 line 12:\n  12 | visible output\n</terminal_context>";
  expect(
    searchableMessageSegments({ role: "user", streaming: false, hasContext: true, text })?.join(
      "\n",
    ),
  ).toContain("visible output");
  expect(searchableMessageSegments({ role: "user", streaming: false, text })).toEqual([]);
});

it("keeps context reference syntax inside code searchable", () => {
  expect(
    searchableMessageSegments({
      role: "user",
      streaming: false,
      text: "`[label](t3-context://v1/terminal/terminal_1)`",
    }),
  ).toEqual(["[label](t3-context://v1/terminal/terminal_1)"]);
});

it("excludes repeated legacy attachments containing literal context tags", () => {
  const context =
    "<terminal_context>\n- Terminal 1 line 12:\n  12 | <terminal_context>literal</terminal_context>\n</terminal_context>";
  expect(
    searchableMessageSegments({
      role: "user",
      streaming: false,
      text: `Fix this\n\n${context}\n\n${context}`,
    }),
  ).toEqual(["Fix this"]);
});

it("keeps plain link targets literal", () => {
  expect(
    searchableMessageSegments({
      role: "assistant",
      streaming: false,
      text: "See [the docs](https://example.com/page) for details.",
    }),
  ).toEqual(["See the docs for details."]);
});

it("indexes nested disclosure summaries and bodies in rendered order", () => {
  expect(
    searchableMessageSegments({
      role: "assistant",
      streaming: false,
      text: "<details><summary>Outer</summary><p>first</p><details><summary>Inner</summary><p>second</p></details></details>",
    }),
  ).toEqual(["Outer", "first", "Inner", "second"]);
});

it("uses line breaks without splitting ordinary assistant prose", () => {
  expect(
    searchableMessageSegments({
      role: "assistant",
      streaming: false,
      text: "★ Insight ─────\nfirst line\nsecond line",
    }),
  ).toEqual(["★ Insight ─────", " first line", " second line"]);
  expect(
    searchableMessageSegments({
      role: "assistant",
      streaming: false,
      text: "first line\nsecond line",
    }),
  ).toEqual(["first line second line"]);
});

it("indexes the citation chip label instead of its link text", () => {
  const citation = {
    version: 1 as const,
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("message"),
    text: "cited   needle",
    start: 0,
    end: 14,
    prefix: "",
    suffix: "",
  };
  const text = `Please fix ${serializeAssistantCitation(citation)} thanks`;
  expect(searchableMessageSegments({ role: "user", text, streaming: false })).toEqual([
    "Please fix cited needle thanks",
  ]);
  const commented = serializeAssistantCitation({ ...citation, comment: "my note" });
  expect(searchableMessageSegments({ role: "user", text: commented, streaming: false })).toEqual([
    "my note",
  ]);
});

it("renders the streaming placeholder and empty-response fallback", () => {
  expect(searchableMessageSegments({ role: "assistant", streaming: true, text: "" })).toEqual([]);
  expect(searchableMessageSegments({ role: "assistant", streaming: false, text: "" })).toEqual([
    "(empty response)",
  ]);
});

it("indexes plans as literal markdown segments", () => {
  const reference = formatComposerContextReference({
    kind: "terminal",
    contextId: "legacy_terminal_1" as never,
    label: "Terminal 1 line 12",
  });
  expect(searchablePlanSegments(`# Plan\n\nDo **the thing**.\n\n${reference}`)).toEqual([
    "Plan",
    "Do the thing.",
    "Terminal 1 line 12",
  ]);
});
