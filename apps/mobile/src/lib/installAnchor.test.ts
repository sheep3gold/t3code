import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const anchorFiles = vi.hoisted(() => new Map<string, string | Error>());
const platform = vi.hoisted(() => ({ OS: "ios" }));

vi.mock("expo-file-system", () => {
  class File {
    readonly name: string;

    constructor(_directory: unknown, name: string) {
      this.name = name;
    }

    get exists() {
      return anchorFiles.has(this.name);
    }

    create() {
      anchorFiles.set(this.name, "");
    }

    write(contents: string) {
      if (!anchorFiles.has(this.name)) anchorFiles.set(this.name, "");
      anchorFiles.set(this.name, contents);
    }

    async text() {
      const contents = anchorFiles.get(this.name);
      if (contents === undefined) throw new Error("Missing file");
      if (contents instanceof Error) throw contents;
      return contents;
    }
  }

  return { File, Paths: { document: "document" } };
});

vi.mock("react-native", () => ({ Platform: platform }));

import {
  __resetInstallAnchorForTest,
  getInstallAnchor,
  initInstallAnchor,
} from "./installAnchor.ts";

describe("installAnchor", () => {
  beforeEach(() => {
    anchorFiles.clear();
    __resetInstallAnchorForTest();
    platform.OS = "ios";
  });

  it("creates the anchor on a fresh install and reports it from then on", async () => {
    expect(getInstallAnchor()).toBeUndefined();

    const first = await initInstallAnchor();
    expect(first).toBeDefined();
    expect(getInstallAnchor()).toBe(first);
    expect(anchorFiles.get("install-anchor.json")).toContain(String(first));

    // Second launch reads the stored value instead of writing a new one.
    const again = await initInstallAnchor();
    expect(again).toBe(first);
  });

  it("regenerates after a reinstall (sandbox file gone)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T08:00:00.000Z"));
    const first = await initInstallAnchor();
    anchorFiles.clear(); // reinstall wipes the app sandbox
    __resetInstallAnchorForTest();
    vi.setSystemTime(new Date("2026-10-14T08:00:00.000Z"));

    const second = await initInstallAnchor();
    expect(second).toBeDefined();
    expect(second).toBe("2026-10-14T08:00:00.000Z");
    expect(second).not.toBe(first);
    vi.useRealTimers();
  });

  it("stays quiet on Android and never blocks startup on failures", async () => {
    platform.OS = "android";
    expect(await initInstallAnchor()).toBeUndefined();
    expect(getInstallAnchor()).toBeUndefined();
    expect(anchorFiles.size).toBe(0);

    platform.OS = "ios";
    anchorFiles.set("install-anchor.json", new Error("disk full"));
    expect(await initInstallAnchor()).toBeUndefined();
  });
});
