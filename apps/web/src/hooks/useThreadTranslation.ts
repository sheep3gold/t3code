import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ChatMessage } from "~/types";

/**
 * Per-thread chat translation into Simplified Chinese.
 *
 * The toggle lives in ChatView so both ChatHeader (button) and
 * MessagesTimeline (rendered translations) read the same state. Translations
 * are cached per message and re-requested when a message's text changes
 * (streaming settles), never more than once per text.
 */

const TRANSLATE_PATH = "/api/translate";
const BATCH_SIZE = 12;
const RETRY_DELAY_MS = 15_000;

export interface ThreadTranslationState {
  readonly enabled: boolean;
  readonly toggle: () => void;
  readonly available: boolean;
  /** translation for a message, undefined while pending or on failure */
  readonly translationFor: (messageId: string) => string | undefined;
  readonly pending: boolean;
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

export function useThreadTranslation(input: {
  readonly threadKey: string;
  readonly messages: ReadonlyArray<ChatMessage>;
}): ThreadTranslationState {
  const { threadKey, messages } = input;
  const [enabledByThread, setEnabledByThread] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [cache, setCache] = useState<ReadonlyMap<string, CacheEntry>>(new Map());
  const [pending, setPending] = useState(false);
  // A render-phase reset keeps the toggle per thread without an effect.
  const [lastThreadKey, setLastThreadKey] = useState(threadKey);
  if (lastThreadKey !== threadKey) {
    setLastThreadKey(threadKey);
    setEnabledByThread(null);
    setPending(false);
  }
  const enabled = enabledByThread === threadKey;
  const cacheRef = useRef(cache);
  const inFlightRef = useRef(new Set<string>());
  const retryTimerRef = useRef<number | null>(null);
  const generationRef = useRef(0);

  // Switching threads invalidates in-flight bookkeeping; the cache is keyed by
  // globally unique message ids, so it survives across threads.
  useEffect(() => {
    cacheRef.current = cache;
  }, [cache]);
  useEffect(() => {
    generationRef.current += 1;
    inFlightRef.current.clear();
    const timer = retryTimerRef.current;
    if (timer !== null) {
      window.clearTimeout(timer);
      retryTimerRef.current = null;
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refs are stable; the reset must run only on thread change
  }, [threadKey]);

  const runPass = useCallback(async () => {
    const generation = generationRef.current;
    const batch: Array<{ id: string; text: string }> = [];
    for (const message of messages) {
      if (batch.length >= BATCH_SIZE) break;
      if (!isTranslatable(message)) continue;
      const cached = cacheRef.current.get(message.id);
      if (cached && cached.source === message.text) continue;
      if (inFlightRef.current.has(message.id)) continue;
      batch.push({ id: message.id, text: message.text });
    }
    if (batch.length === 0) {
      setPending(false);
      return;
    }
    for (const item of batch) inFlightRef.current.add(item.id);
    setPending(true);
    try {
      const response = await fetch(TRANSLATE_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: batch.map((item) => item.text) }),
      });
      if (response.status === 503) {
        // Not configured on this server; stop hammering and turn the toggle off.
        setAvailable(false);
        setEnabledByThread(null);
        return;
      }
      if (!response.ok) throw new Error(`translate failed: ${response.status}`);
      const payload = (await response.json()) as { translations?: unknown };
      const translations = payload.translations;
      if (!Array.isArray(translations) || translations.length !== batch.length) {
        throw new Error("translate returned a malformed payload");
      }
      if (generation !== generationRef.current) return;
      setCache((previous) => {
        const next = new Map(previous);
        for (let index = 0; index < batch.length; index += 1) {
          const translation = translations[index];
          if (typeof translation === "string" && translation.length > 0) {
            next.set(batch[index]!.id, { source: batch[index]!.text, translation });
          }
        }
        return next;
      });
    } catch {
      // Leave the entries uncached; a retry pass is scheduled by the caller.
      if (generation === generationRef.current && retryTimerRef.current === null) {
        const scheduleRetry = retryScheduleRef.current;
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          scheduleRetry();
        }, RETRY_DELAY_MS);
      }
    } finally {
      for (const item of batch) inFlightRef.current.delete(item.id);
      if (generation === generationRef.current) {
        // More messages may have arrived while this batch was in flight.
        const remaining = messages.some(
          (message) =>
            isTranslatable(message) &&
            cacheRef.current.get(message.id)?.source !== message.text &&
            !inFlightRef.current.has(message.id),
        );
        setPending(remaining);
      }
    }
  }, [messages]);

  const retryScheduleRef = useRef(() => {});
  useEffect(() => {
    const schedule = () => void runPass();
    // oxlint-disable-next-line react/immutability -- publishing the latest pass to the retry timer is the point of the ref
    retryScheduleRef.current = schedule;
    if (enabled) schedule();
  }, [enabled, runPass]);

  const toggle = useCallback(
    () => setEnabledByThread((current) => (current === threadKey ? null : threadKey)),
    [threadKey],
  );

  const translationFor = useCallback(
    (messageId: string): string | undefined => {
      if (!enabled) return undefined;
      const message = messages.find((candidate) => candidate.id === messageId);
      if (!message) return undefined;
      const entry = cache.get(messageId);
      return entry && entry.source === message.text ? entry.translation : undefined;
    },
    [cache, enabled, messages],
  );

  return useMemo(
    () => ({ enabled, toggle, available, translationFor, pending }),
    [enabled, toggle, available, translationFor, pending],
  );
}
