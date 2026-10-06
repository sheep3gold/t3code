import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Chat translation proxy contract. `POST /api/translate` forwards natural-language
 * message text to an OpenAI-compatible upstream and returns the Chinese
 * translation. The route authenticates inside its handler (bearer, DPoP, cookie,
 * and the desktop shell's `wsTicket` query parameter all work), so it is
 * declared without the shared auth middleware and carries its own error union.
 */
export const EnvironmentTranslatePayload = Schema.Struct({
  texts: Schema.Array(Schema.String),
});

export const EnvironmentTranslateResult = Schema.Struct({
  translations: Schema.Array(Schema.String),
});

/** Upstream translation is not configured on this server (no API key). */
export class EnvironmentTranslateUnavailableError extends Schema.TaggedError<EnvironmentTranslateUnavailableError>()(
  "EnvironmentTranslateUnavailableError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentTranslateUnavailableError)(this, {
      status: 503,
    });
  }
}

/** The translation upstream failed, timed out, or answered with a malformed payload. */
export class EnvironmentTranslateUpstreamError extends Schema.TaggedError<EnvironmentTranslateUpstreamError>()(
  "EnvironmentTranslateUpstreamError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 502 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentTranslateUpstreamError)(this, {
      status: 502,
    });
  }
}
