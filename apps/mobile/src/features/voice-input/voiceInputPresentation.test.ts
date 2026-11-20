import { describe, expect, it } from "vite-plus/test";
import { m } from "../../i18n/messages";
import { resolveVoiceComposerPresentation } from "./voiceInputPresentation";

describe("resolveVoiceComposerPresentation", () => {
  it("keeps the mic presentation while a finger holds it", () => {
    expect(
      resolveVoiceComposerPresentation(
        { phase: "recording", error: null, errorAction: null },
        3,
        m,
        true,
      ),
    ).toMatchObject({ trailingAction: "mic", statusLabel: null });
  });
});
