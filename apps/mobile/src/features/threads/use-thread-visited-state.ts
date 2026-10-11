import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { shouldSyncThreadRead } from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import {
  markThreadVisitedPreferences,
  type Preferences,
} from "../../persistence/mobile-preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * "Has the user seen this completion" state. Servers that store read state
 * (thread.lastReadAt) are the source of truth shared with web and desktop;
 * the device-local map — the counterpart of web's
 * uiStateStore.threadLastVisitedAtById — is the fallback for threads the
 * server has no stamp for and for older servers. Opening a thread stamps the
 * visit at the turn's completion time (not now) so a completion that lands
 * later still gets its signal. Preferences stay unloaded during sign-in —
 * the map is empty then, which the sort reads as "nothing unseen", matching
 * web's never-visited-is-read rule.
 */
export function useThreadVisitedState() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const markReadMutation = useAtomCommand(threadEnvironment.markRead, { reportFailure: false });
  const threadLastVisitedAtById: Readonly<Record<string, string>> = AsyncResult.isSuccess(
    preferencesResult,
  )
    ? (preferencesResult.value.threadLastVisitedAtById ?? {})
    : {};

  const markThreadVisited = useCallback(
    (input: {
      readonly threadKey: string;
      readonly visitedAt: string;
      /** Server identity and current shared stamp; omit for local-only. */
      readonly thread?: {
        readonly environmentId: EnvironmentId;
        readonly threadId: ThreadId;
        readonly lastReadAt?: string | null | undefined;
      };
    }) => {
      savePreferences({
        transform: (current: Preferences) => markThreadVisitedPreferences(current, input),
      });
      const thread = input.thread;
      if (thread === undefined || !shouldSyncThreadRead(thread, input.visitedAt)) return;
      const supportsReadState =
        appAtomRegistry.get(environmentServerConfigsAtom).get(thread.environmentId)?.environment
          .capabilities.threadReadState === true;
      if (!supportsReadState) return;
      void markReadMutation({
        environmentId: thread.environmentId,
        input: { threadId: thread.threadId, readAt: input.visitedAt },
      });
    },
    [markReadMutation, savePreferences],
  );

  return { markThreadVisited, threadLastVisitedAtById } as const;
}
