import { describe, expect, it } from "vite-plus/test";

import {
  isOptionSelected,
  parseAssistantOptions,
  resolveActiveOptionSource,
  toggleOptionInPrompt,
  type AssistantOptionMessage,
} from "./assistantOptions.ts";

const assistant = (id: string, text: string, streaming = false): AssistantOptionMessage => ({
  id,
  role: "assistant",
  text,
  streaming,
});

const user = (id: string, text: string): AssistantOptionMessage => ({
  id,
  role: "user",
  text,
  streaming: false,
});

describe("parseAssistantOptions", () => {
  it("extracts and deduplicates options from the final line", () => {
    expect(parseAssistantOptions("请选择：\n\n[OPTIONS: 甲 | 乙 | 甲 ]")).toEqual({
      body: "请选择：",
      options: ["甲", "乙"],
    });
  });

  it("does not consume an incomplete or non-final marker", () => {
    expect(parseAssistantOptions("正文\n[OPTIONS: 甲 | 乙")).toBeNull();
    expect(parseAssistantOptions("[OPTIONS: 甲 | 乙]\n正文")).toBeNull();
  });
});

describe("option prompt selection", () => {
  it("appends different options as blocks", () => {
    expect(toggleOptionInPrompt(toggleOptionInPrompt("手写内容", "甲"), "乙")).toBe(
      "手写内容\n\n甲\n\n乙",
    );
  });

  it("removes the same option on the second tap without touching other text", () => {
    const selected = toggleOptionInPrompt("手写内容", "甲");
    expect(isOptionSelected(selected, "甲")).toBe(true);
    expect(toggleOptionInPrompt(selected, "甲")).toBe("手写内容");
  });
});

describe("resolveActiveOptionSource", () => {
  it("offers the candidates of the last assistant reply", () => {
    const source = resolveActiveOptionSource([
      user("u1", "开始"),
      assistant("a1", "先做哪个？\n\n[OPTIONS: 甲 | 乙]"),
    ]);
    expect(source).toEqual({ messageId: "a1", options: ["甲", "乙"] });
  });

  it("drops the candidates once the user replied after them", () => {
    const source = resolveActiveOptionSource([
      assistant("a1", "先做哪个？\n\n[OPTIONS: 甲 | 乙]"),
      user("u1", "甲"),
    ]);
    expect(source).toBeNull();
  });

  it("keeps offering the candidates while the user only collects them", () => {
    const source = resolveActiveOptionSource([assistant("a1", "先做哪个？\n\n[OPTIONS: 甲 | 乙]")]);
    expect(source?.options).toEqual(["甲", "乙"]);
  });

  it("withholds the candidates while the reply is still streaming", () => {
    const source = resolveActiveOptionSource([assistant("a1", "先做哪个？\n\n[OPTIONS: 甲", true)]);
    expect(source).toBeNull();
  });

  it("has nothing to offer when the last reply carries no marker", () => {
    const source = resolveActiveOptionSource([assistant("a1", "做完了")]);
    expect(source).toBeNull();
  });
});
