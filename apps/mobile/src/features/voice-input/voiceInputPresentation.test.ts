import { describe, expect, it } from "vite-plus/test";

import { resolveVoiceComposerPresentation } from "./voiceInputPresentation";

describe("resolveVoiceComposerPresentation", () => {
  it("keeps the mic presentation while a finger holds it", () => {
    expect(
      resolveVoiceComposerPresentation(
        { phase: "recording", error: null, errorAction: null },
        3,
        (key) => key,
        true,
      ),
    ).toMatchObject({ trailingAction: "mic", statusLabel: null });
  });
});
