import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import type { ChatMessage } from "../types";

/**
 * On-demand per-message translation into Simplified Chinese.
 *
 * Each user/assistant row renders its own translate button; clicking it
 * translates exactly that message. Results are cached per message id and
 * re-requested when the message text changes (streaming settles). The cache
 * survives thread switches since message ids are globally unique.
 *
 * The request must target the primary environment's real HTTP origin: inside
 * the desktop shell the page origin is the t3code:// asset protocol, whose
 * handler only serves static files (a relative fetch there gets a 405 and the
 * click appears to do nothing). Same-origin browser sessions authenticate via
 * cookie; the desktop shell attaches the local environment bearer token.
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

async function postTranslateRequest(source: string): Promise<Response> {
  const url = resolvePrimaryEnvironmentHttpUrl("/api/translate");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const bearerToken = await readDesktopPrimaryBearerToken();
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
}): ThreadTranslationState {
  const { threadKey, messages } = input;
  const [available, setAvailable] = useState(true);
  const [cache, setCache] = useState<ReadonlyMap<string, CacheEntry>>(new Map());
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const cacheRef = useRef(cache);
  const inFlightRef = useRef(new Set<string>());
  const retryTimersRef = useRef(new Map<string, number>());
  const generationRef = useRef(0);

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

    void postTranslateRequest(source)
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
