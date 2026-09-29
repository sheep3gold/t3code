import { describe, expect, it } from "vite-plus/test";

import {
  pullRequestActionableReasons,
  pullRequestMonitorFingerprint,
} from "./PullRequestSyncReactor.ts";

const snapshot = {
  state: "open" as const,
  updatedAt: "2026-09-26T12:00:00.000Z",
  checksState: "passing" as const,
  reviewDecision: "approved" as const,
  mergeability: "mergeable" as const,
};

describe("pull request monitor", () => {
  it("wakes only for typed actionable provider states", () => {
    expect(pullRequestActionableReasons(snapshot)).toEqual([]);
    expect(
      pullRequestActionableReasons({
        ...snapshot,
        checksState: "failing",
        reviewDecision: "changes-requested",
        mergeability: "conflicting",
      }),
    ).toEqual([
      "CI checks are failing",
      "review changes were requested",
      "the pull request has merge conflicts",
    ]);
    expect(
      pullRequestActionableReasons({
        ...snapshot,
        checksState: "pending",
        reviewDecision: "review-required",
        mergeability: "unknown",
      }),
    ).toEqual([]);
    expect(pullRequestActionableReasons({ ...snapshot, state: "merged" })).toEqual([]);
  });

  it("changes the fingerprint when provider action evidence changes", () => {
    const first = pullRequestMonitorFingerprint(snapshot);
    expect(pullRequestMonitorFingerprint(snapshot)).toBe(first);
    expect(pullRequestMonitorFingerprint({ ...snapshot, checksState: "failing" })).not.toBe(first);
    expect(
      pullRequestMonitorFingerprint({
        ...snapshot,
        updatedAt: "2026-09-26T12:01:00.000Z",
      }),
    ).not.toBe(first);
  });
});
