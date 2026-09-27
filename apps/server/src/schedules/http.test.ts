import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canScheduleThread } from "./http.ts";

const projectId = ProjectId.make("project-1");

describe("canScheduleThread", () => {
  it("accepts an active thread in the requested project without requiring deletedAt", () => {
    expect(canScheduleThread({ projectId, archivedAt: null }, projectId)).toBe(true);
  });

  it("rejects archived threads and cross-project requests", () => {
    expect(
      canScheduleThread({ projectId, archivedAt: "2026-09-27T00:00:00.000Z" }, projectId),
    ).toBe(false);
    expect(canScheduleThread({ projectId, archivedAt: null }, ProjectId.make("project-2"))).toBe(
      false,
    );
  });
});
