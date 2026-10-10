import {
  McpCapabilityUnavailableError,
  SecretRef,
  SecretRequestError,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  SecretRequests.SecretRequests,
];

export class RequestSecretUnavailableError extends Schema.TaggedError<RequestSecretUnavailableError>()(
  "RequestSecretUnavailableError",
  { cause: Schema.optionalKey(Schema.Defect()) },
) {
  override get message(): string {
    return "Could not ask the user for a secret right now.";
  }
}

export const SecretToolError = Schema.Union([
  McpCapabilityUnavailableError,
  RequestSecretUnavailableError,
  SecretRequestError,
]);
export type SecretToolError = typeof SecretToolError.Type;

export const RequestSecretInput = Schema.Struct({
  label: TrimmedNonEmptyString.annotate({
    description: "What you need, shown as the card's title, e.g. 'GitHub webhook secret'.",
  }),
  reason: TrimmedNonEmptyString.annotate({
    description:
      "One or two sentences on what it is for and where the user gets or also enters it.",
  }),
  placeholder: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "Hint inside the input, e.g. 'Paste your GitHub token'.",
  }),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 60 * 60 * 1_000 })),
  ).annotate({ description: "How long to wait for the user. Default 10 minutes." }),
  clientRequestId: Schema.optional(TrimmedNonEmptyString).annotate({
    description:
      "Reuse when retrying a call that lost its result, so the user sees one card and its answer is returned again. Use a new id to ask again after timed_out or cancelled.",
  }),
});
export type RequestSecretInput = typeof RequestSecretInput.Type;

export const RequestSecretResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("saved").annotate({ description: "secretRef holds the value." }),
    secretRef: SecretRef.annotate({
      description:
        "Pass it to a tool that accepts a secretRef; it works once, and you never see the value.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literals(["declined", "cancelled", "timed_out"]).annotate({
      description:
        "declined: the user chose not to. cancelled: the request ended with the turn. timed_out: the user did not answer in time; the card is closed, so ask again with a new clientRequestId if still needed.",
    }),
  }),
]);
export type RequestSecretResult = typeof RequestSecretResult.Type;

const RequestSecretTool = Tool.make("request_secret", {
  description:
    "Ask the user for a secret (a token, API key, signing secret, password) through a private card in this thread, and wait for them to answer. The value is kept by the app and NEVER returned to you or shown in the transcript. When saved, the result carries a secretRef: pass it to a tool that accepts one. It works once. Never ask for secrets in chat, and never invent one.",
  parameters: RequestSecretInput,
  success: RequestSecretResult,
  failure: SecretToolError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Request a secret from the user")
  .annotate(Tool.Destructive, false);

export const SecretsToolkit = Toolkit.make(RequestSecretTool);
