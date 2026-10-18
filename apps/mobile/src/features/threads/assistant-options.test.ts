import { describe, expect, it } from "vite-plus/test";

import { isOptionSelected, parseAssistantOptions, toggleOptionInPrompt } from "./assistant-options";

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
