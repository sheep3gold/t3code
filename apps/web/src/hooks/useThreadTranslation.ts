import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { EnvironmentId } from "@t3tools/contracts";

import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import { readPreparedConnection } from "../state/session";
import type { ChatMessage } from "../types";

/**
 * On-demand per-message translation into Simplified Chinese.
 *
 * Each user/assistant row renders its own translate button; clicking it
 * translates exactly that message. Results are cached per message id and
 * re-requested when the message text changes (streaming settles). The cache
 * survives thread switches since message ids are globally unique.
 *
 * The request must reach the environment that owns the thread, which is not
 * necessarily the primary one: a desktop app with its local environment
 * disabled has no primary target at all. Inside the desktop shell the page
 * origin is also the t3code:// asset protocol, so a relative fetch would hit
 * the static-asset handler (405) instead of any server — and an
 * Authorization-header fetch would trigger a CORS preflight the custom
 * scheme cannot express. Header-less clients therefore authenticate with a
 * short-lived `wsTicket` query parameter minted by the environment itself,
 * the same pattern as the /ws upgrade and the device-hub proxy; same-origin
 * browser sessions keep cookie auth via credentials: "include".
 */

const RETRY_DELAY_MS = 15_000;

export interface ThreadTranslationState {
  /** False when the server has no translation upstream configured (503). */
  readonly available: boolean;
  /** Kick off a translation for one message; no-op while pending or cached. */
  readonly translateMessage: (messageId: string) => void;
  /** Translation for a message, undefined until its own request lands. */
  readonly translationFor: (messageId: string) => string | undefined;
  /** Whether this message has a translation request in flight. */
  readonly pendingFor: (messageId: string) => boolean;
}

interface CacheEntry {
  /** source text the translation was produced from */
  readonly source: string;
  readonly translation: string;
}

function isTranslatable(message: ChatMessage): boolean {
  return (
    (message.role === "user" || message.role === "assistant") &&
    !message.streaming &&
    message.text.trim().length > 0
  );
}

function mintTicket(httpBaseUrl: string, bearerToken: string): Promise<string> {
  const url = new URL("/api/auth/websocket-ticket", httpBaseUrl);
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearerToken}` },
    credentials: "omit",
  }).then(async (response) => {
    if (!response.ok) throw new Error(`ticket mint failed: ${response.status}`);
    const payload = (await response.json()) as { ticket?: unknown };
    if (typeof payload.ticket !== "string" || payload.ticket.length === 0) {
      throw new Error("ticket mint returned a malformed payload");
    }
    return payload.ticket;
  });
}

async function postTranslateRequest(
  environmentId: EnvironmentId | null,
  source: string,
): Promise<Response> {
  if (environmentId !== null) {
    const connection = readPreparedConnection(environmentId);
    if (connection) {
      const url = new URL("/api/translate", connection.httpBaseUrl);
      const authorization = connection.httpAuthorization;
      if (authorization === null) {
        // Cookie session; only same-origin requests carry cookies.
        return fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ texts: [source] }),
        });
      }
      const bearerToken =
        authorization._tag === "Bearer" ? authorization.token : authorization.accessToken;
      const ticket = await mintTicket(connection.httpBaseUrl, bearerToken);
      url.searchParams.set("wsTicket", ticket);
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify({ texts: [source] }),
      });
    }
  }

  // Fallback for a primary-only world (plain browser dev sessions where the
  // thread's environment has no prepared connection yet): resolve the primary
  // target, attach the desktop local bearer token when one exists, and rely on
  // cookies otherwise. Throws PrimaryEnvironmentDisabledError when there is no
  // primary at all; the caller treats that like any other failure and retries.
  const url = resolvePrimaryEnvironmentHttpUrl("/api/translate");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const bearerToken = await readDesktopPrimaryBearerToken().catch(() => null);
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  return fetch(url, {
    method: "POST",
    headers,
    credentials: bearerToken ? "omit" : "include",
    body: JSON.stringify({ texts: [source] }),
  });
}

export function useThreadTranslation(input: {
  readonly threadKey: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  /** Environment that owns the thread; null falls back to the primary target. */
  readonly environmentId?: EnvironmentId | null;
}): ThreadTranslationState {
  const { threadKey, messages, environmentId = null } = input;
  const [available, setAvailable] = useState(true);
  const [cache, setCache] = useState<ReadonlyMap<string, CacheEntry>>(new Map());
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const cacheRef = useRef(cache);
  const inFlightRef = useRef(new Set<string>());
  const retryTimersRef = useRef(new Map<string, number>());
  const generationRef = useRef(0);
  const environmentIdRef = useRef(environmentId);
  environmentIdRef.current = environmentId;

  useEffect(() => {
    cacheRef.current = cache;
  }, [cache]);

  // Switching threads abandons in-flight bookkeeping; timers are cancelled so
  // a retry from the previous thread cannot write state after the switch.
  const [lastThreadKey, setLastThreadKey] = useState(threadKey);
  if (lastThreadKey !== threadKey) {
    setLastThreadKey(threadKey);
    setPendingIds(new Set());
  }
  useEffect(() => {
    generationRef.current += 1;
    inFlightRef.current.clear();
    for (const timer of retryTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    retryTimersRef.current.clear();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refs are stable; the reset must run only on thread change
  }, [threadKey]);

  const messagesByIdRef = useRef(new Map<string, ChatMessage>());
  useEffect(() => {
    const next = new Map<string, ChatMessage>();
    for (const message of messages) next.set(message.id, message);
    messagesByIdRef.current = next;
  }, [messages]);

  const translateMessageRef = useRef<(messageId: string) => void>(() => {});
  const translateMessage = useCallback((messageId: string) => {
    const message = messagesByIdRef.current.get(messageId);
    if (!message || !isTranslatable(message)) return;
    const cached = cacheRef.current.get(messageId);
    if (cached && cached.source === message.text) return;
    if (inFlightRef.current.has(messageId)) return;

    const generation = generationRef.current;
    const source = message.text;
    inFlightRef.current.add(messageId);
    setPendingIds((previous) => {
      const next = new Set(previous);
      next.add(messageId);
      return next;
    });

    const finish = () => {
      inFlightRef.current.delete(messageId);
      if (generation !== generationRef.current) return;
      setPendingIds((previous) => {
        if (!previous.has(messageId)) return previous;
        const next = new Set(previous);
        next.delete(messageId);
        return next;
      });
    };

    void postTranslateRequest(environmentIdRef.current, source)
      .then(async (response) => {
        if (response.status === 503) {
          // Not configured on this server; surface the state on the buttons.
          setAvailable(false);
          return;
        }
        if (!response.ok) throw new Error(`translate failed: ${response.status}`);
        const payload = (await response.json()) as { translations?: unknown };
        const translations = payload.translations;
        if (!Array.isArray(translations) || translations.length !== 1) {
          throw new Error("translate returned a malformed payload");
        }
        const translation = translations[0];
        if (typeof translation !== "string" || translation.length === 0) {
          throw new Error("translate returned an empty translation");
        }
        if (generation !== generationRef.current) return;
        setCache((previous) => {
          const next = new Map(previous);
          next.set(messageId, { source, translation });
          return next;
        });
      })
      .catch(() => {
        // Retry this message once after a delay, only if nothing newer started.
        if (generation !== generationRef.current) return;
        if (retryTimersRef.current.has(messageId)) return;
        const timer = window.setTimeout(() => {
          retryTimersRef.current.delete(messageId);
          if (generation === generationRef.current) {
            inFlightRef.current.delete(messageId);
            translateMessageRef.current(messageId);
          }
        }, RETRY_DELAY_MS);
        retryTimersRef.current.set(messageId, timer);
      })
      .finally(finish);
  }, []);
  useEffect(() => {
    translateMessageRef.current = translateMessage;
  }, [translateMessage]);

  const translationFor = useCallback(
    (messageId: string): string | undefined => {
      const message = messagesByIdRef.current.get(messageId);
      if (!message) return undefined;
      const entry = cache.get(messageId);
      return entry && entry.source === message.text ? entry.translation : undefined;
    },
    [cache],
  );

  const pendingFor = useCallback(
    (messageId: string): boolean => pendingIds.has(messageId),
    [pendingIds],
  );

  return useMemo(
    () => ({ available, translateMessage, translationFor, pendingFor }),
    [available, translateMessage, translationFor, pendingFor],
  );
}
