import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import {
  markThreadVisitedPreferences,
  type Preferences,
} from "../../persistence/mobile-preferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/**
 * Device-local "has the user seen this completion" state, the mobile
 * counterpart of web's uiStateStore.threadLastVisitedAtById. The list model
 * lifts unseen completions to the top of the active block; opening a thread
 * stamps the visit at the turn's completion time (not now) so a completion
 * that lands later still gets its signal. Preferences stay unloaded during
 * sign-in — the map is empty then, which the sort reads as "nothing
 * unseen", matching web's never-visited-is-read rule.
 */
export function useThreadVisitedState() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const threadLastVisitedAtById: Readonly<Record<string, string>> = AsyncResult.isSuccess(
    preferencesResult,
  )
    ? (preferencesResult.value.threadLastVisitedAtById ?? {})
    : {};

  const markThreadVisited = useCallback(
    (input: { readonly threadKey: string; readonly visitedAt: string }) => {
      savePreferences({
        transform: (current: Preferences) => markThreadVisitedPreferences(current, input),
      });
    },
    [savePreferences],
  );

  return { markThreadVisited, threadLastVisitedAtById } as const;
}
