import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { shouldSyncThreadRead } from "@t3tools/client-runtime/state/thread-sort";
import { useCallback } from "react";

import { readEnvironmentSupportsReadState, readThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useUiStateStore } from "../uiStateStore";

/**
 * Read/unread stamps for a thread, same signatures as the uiStateStore
 * actions they wrap. The local stamp still updates immediately (and is the
 * whole story on servers without shared read state); servers that store
 * read state also get the stamp so every device — web, desktop, mobile —
 * agrees on what is unread.
 */
export function useThreadReadState() {
  const markThreadVisitedLocal = useUiStateStore((state) => state.markThreadVisited);
  const markThreadUnreadLocal = useUiStateStore((state) => state.markThreadUnread);
  const markReadMutation = useAtomCommand(threadEnvironment.markRead, { reportFailure: false });
  const markUnreadMutation = useAtomCommand(threadEnvironment.markUnread, {
    reportFailure: false,
  });

  const markThreadVisited = useCallback(
    (threadKey: string, visitedAt: string) => {
      markThreadVisitedLocal(threadKey, visitedAt);
      const threadRef = parseScopedThreadKey(threadKey);
      if (threadRef === null || !readEnvironmentSupportsReadState(threadRef.environmentId)) return;
      const shell = readThreadShell(threadRef);
      if (shell === null || !shouldSyncThreadRead(shell, visitedAt)) return;
      void markReadMutation({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, readAt: visitedAt },
      });
    },
    [markReadMutation, markThreadVisitedLocal],
  );

  const markThreadUnread = useCallback(
    (threadKey: string, latestTurnCompletedAt: string | null | undefined) => {
      markThreadUnreadLocal(threadKey, latestTurnCompletedAt);
      if (!latestTurnCompletedAt) return;
      const threadRef = parseScopedThreadKey(threadKey);
      if (threadRef === null || !readEnvironmentSupportsReadState(threadRef.environmentId)) return;
      void markUnreadMutation({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
    },
    [markThreadUnreadLocal, markUnreadMutation],
  );

  return { markThreadVisited, markThreadUnread } as const;
}
