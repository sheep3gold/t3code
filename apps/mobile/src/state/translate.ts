import type { EnvironmentId } from "@t3tools/contracts";
import {
  createEnvironmentTranslateAtoms,
  isTranslateUnavailable,
} from "@t3tools/client-runtime/state/translate";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useRef, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "./use-atom-command";

export const translateEnvironment = createEnvironmentTranslateAtoms(connectionAtomRuntime);

/**
 * On-demand per-message translation into Simplified Chinese, mirroring the web
 * client's `useThreadTranslation`. Each translatable row renders a translate
 * button; tapping it translates exactly that message. Results are cached per
 * message id and re-requested when the source text changes (streaming settles).
 */
export interface MessageTranslationState {
  /** False once the server answered 503 (no upstream configured); buttons hide. */
  readonly available: boolean;
  /** Kick off a translation for one message; no-op while pending or cached. */
  readonly translateMessage: (messageId: string, sourceText: string) => void;
  /** Translation for a message, undefined until its own request lands. */
  readonly translationFor: (messageId: string, sourceText: string) => string | undefined;
  /** Whether this message has a translation request in flight. */
  readonly pendingFor: (messageId: string) => boolean;
}

interface CacheEntry {
  /** source text the translation was produced from */
  readonly source: string;
  readonly translation: string;
}

export function useThreadTranslation(environmentId: EnvironmentId): MessageTranslationState {
  const translate = useAtomCommand(translateEnvironment.translate, { reportFailure: false });
  const [available, setAvailable] = useState(true);
  const [cache, setCache] = useState<ReadonlyMap<string, CacheEntry>>(new Map());
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const inFlightRef = useRef(new Set<string>());

  const translateMessage = useCallback(
    (messageId: string, sourceText: string) => {
      const text = sourceText.trim();
      if (text.length === 0) return;
      const cached = cacheRef.current.get(messageId);
      if (cached && cached.source === sourceText) return;
      if (inFlightRef.current.has(messageId)) return;

      inFlightRef.current.add(messageId);
      setPendingIds((previous) => {
        const next = new Set(previous);
        next.add(messageId);
        return next;
      });
      const finish = () => {
        inFlightRef.current.delete(messageId);
        setPendingIds((previous) => {
          if (!previous.has(messageId)) return previous;
          const next = new Set(previous);
          next.delete(messageId);
          return next;
        });
      };

      void translate({ environmentId, input: { texts: [sourceText] } })
        .then((result) => {
          if (isAtomCommandInterrupted(result)) return;
          if (result._tag === "Failure") {
            if (isTranslateUnavailable(squashAtomCommandFailure(result))) {
              // Not configured on this server; hide the buttons.
              setAvailable(false);
            }
            return;
          }
          const translation = result.value.translations[0];
          if (typeof translation !== "string" || translation.length === 0) return;
          setCache((previous) => {
            const next = new Map(previous);
            next.set(messageId, { source: sourceText, translation });
            return next;
          });
        })
        .finally(finish);
    },
    [environmentId, translate],
  );

  const translationFor = useCallback(
    (messageId: string, sourceText: string): string | undefined => {
      const entry = cache.get(messageId);
      return entry && entry.source === sourceText ? entry.translation : undefined;
    },
    [cache],
  );

  const pendingFor = useCallback(
    (messageId: string): boolean => pendingIds.has(messageId),
    [pendingIds],
  );

  return { available, translateMessage, translationFor, pendingFor };
}
