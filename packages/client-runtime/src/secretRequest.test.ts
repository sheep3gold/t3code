import { describe, expect, it } from "@effect/vitest";
import { ApprovalRequestId, ThreadId, type OrchestrationThreadActivity } from "@t3tools/contracts";

import { foldUserInputActivities } from "./work-log/userInput.ts";
import {
  deriveSecretRequestCards,
  isSecretRequestActivity,
  secretRequestAnswerInput,
  secretRequestFailureMessage,
} from "./secretRequest.ts";

const threadId = ThreadId.make("thread-1");
const requestId = ApprovalRequestId.make("secret-request:thread-1:req-1");

const requestedActivity = (overrides: Record<string, unknown> = {}) =>
  ({
    kind: "user-input.requested",
    threadId,
    createdAt: "2026-10-10T00:00:00.000Z",
    payload: {
      requestId,
      responseMode: "message",
      secretRequest: true,
      label: "GitHub token",
      reason: "Used as GH_TOKEN.",
      placeholder: "Paste your token",
      ...overrides,
    },
  }) as unknown as OrchestrationThreadActivity;

const resolvedActivity = (secretStatus: string) =>
  ({
    kind: "user-input.resolved",
    threadId,
    createdAt: "2026-10-10T00:00:01.000Z",
    payload: { requestId, responseMode: "message", secretStatus },
  }) as unknown as OrchestrationThreadActivity;

describe("isSecretRequestActivity", () => {
  it("matches only message-mode user-input requests flagged secretRequest", () => {
    expect(isSecretRequestActivity(requestedActivity())).toBe(true);
    expect(isSecretRequestActivity(requestedActivity({ secretRequest: false }))).toBe(false);
    expect(isSecretRequestActivity(requestedActivity({ responseMode: "callback" }))).toBe(false);
    expect(isSecretRequestActivity(resolvedActivity("saved"))).toBe(false);
  });
});

describe("deriveSecretRequestCards", () => {
  it("shows the form while pending and the outcome after a resolution", () => {
    const [pending] = deriveSecretRequestCards(threadId, [requestedActivity()]);
    expect(pending?.display).toEqual({ kind: "pending" });
    expect(pending?.card).toMatchObject({
      requestId,
      label: "GitHub token",
      reason: "Used as GH_TOKEN.",
      placeholder: "Paste your token",
    });

    expect(
      deriveSecretRequestCards(threadId, [requestedActivity(), resolvedActivity("saved")])[0]
        ?.display,
    ).toEqual({ kind: "answered", outcome: "saved" });
    expect(
      deriveSecretRequestCards(threadId, [requestedActivity(), resolvedActivity("declined")])[0]
        ?.display,
    ).toEqual({ kind: "answered", outcome: "declined" });
    expect(
      deriveSecretRequestCards(threadId, [requestedActivity(), resolvedActivity("cancelled")])[0]
        ?.display,
    ).toEqual({ kind: "answered", outcome: "ended" });
  });

  it("ignores ordinary user-input questions and resolutions for other requests", () => {
    const ordinary = requestedActivity({ secretRequest: undefined });
    expect(deriveSecretRequestCards(threadId, [ordinary])).toEqual([]);
    expect(
      deriveSecretRequestCards(threadId, [
        requestedActivity(),
        resolvedActivity("saved"),
        // An unrelated resolution must not close the card.
        {
          kind: "user-input.resolved",
          threadId,
          createdAt: "2026-10-10T00:00:02.000Z",
          payload: { requestId: "secret-request:thread-1:other", responseMode: "message" },
        } as unknown as OrchestrationThreadActivity,
      ])[0]?.display,
    ).toEqual({ kind: "answered", outcome: "saved" });
  });

  it("a card answered before this client loaded still shows its outcome, never the form", () => {
    // Resolution arrives in the same batch as the request (e.g. initial load).
    const cards = deriveSecretRequestCards(threadId, [
      requestedActivity(),
      resolvedActivity("declined"),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.display.kind).toBe("answered");
  });

  it("the work-log fold leaves a secret request and its resolution untouched", () => {
    const folded = foldUserInputActivities([requestedActivity(), resolvedActivity("saved")]);
    expect(folded.map((activity) => activity.kind)).toEqual([
      "user-input.requested",
      "user-input.resolved",
    ]);
  });
});

describe("secretRequestAnswerInput", () => {
  const card = { threadId, requestId };

  it("refuses a blank save and trims the value the server will store", () => {
    expect(secretRequestAnswerInput(card, { type: "save", secret: "   " })).toBeNull();
    expect(secretRequestAnswerInput(card, { type: "save", secret: " whsec_1 " })).toEqual({
      threadId,
      requestId,
      answer: { type: "save", secret: "whsec_1" },
    });
  });

  it("declines without a value", () => {
    expect(secretRequestAnswerInput(card, { type: "decline" })).toEqual({
      threadId,
      requestId,
      answer: { type: "decline" },
    });
  });
});

describe("secretRequestFailureMessage", () => {
  it("passes known server error messages through and hides everything else", () => {
    expect(
      secretRequestFailureMessage({
        _tag: "SecretRequestError",
        message: "The request was already answered.",
      }),
    ).toBe("The request was already answered.");
    // A transport error could carry the request payload; it never reaches the UI.
    expect(
      secretRequestFailureMessage({ _tag: "RpcTransportError", message: "whsec_1 leaked" }),
    ).toBe("Could not answer the request. Try again.");
    expect(secretRequestFailureMessage(new Error("boom"))).toBe(
      "Could not answer the request. Try again.",
    );
  });
});
