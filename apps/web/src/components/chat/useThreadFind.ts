import type { OrchestrationSearchThreadResult, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { useDebouncedValue } from "~/state/queries";
import {
  type ThreadFindPositionReader,
  type ThreadFindStart,
  stepThreadFindIndex,
} from "./threadFind";
import { subscribeThreadFindOpen } from "./threadFindActionBus";
import { toastManager } from "../ui/toast";

const CLOSED_FIND = {
  threadKey: null as string | null,
  query: "",
  offset: 0,
  start: undefined as ThreadFindStart | undefined,
  focusRequestId: 0,
  navigationId: 0,
  requestId: 0,
  localSelection: null as {
    base: OrchestrationSearchThreadResult;
    baseNavigationId: number;
    activeIndex: number;
    match: NonNullable<OrchestrationSearchThreadResult["match"]>;
    navigationId: number;
  } | null,
};

/** Owns find state for the active thread and its environment. */
export function useThreadFind({
  thread,
  enabled,
  contentVersion,
}: {
  thread: ScopedThreadRef | null;
  enabled: boolean;
  /** Bumps when thread content changes so live matches refresh while find stays open. */
  contentVersion: unknown;
}) {
  const findPositionReaderRef = useRef<ThreadFindPositionReader | null>(null);
  const lastContentRef = useRef(contentVersion);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const threadKey = thread ? scopedThreadKey(thread) : null;
  const [state, setState] = useState(CLOSED_FIND);
  if (state.threadKey !== null && (!enabled || state.threadKey !== threadKey))
    setState(CLOSED_FIND);
  const isOpen = enabled && threadKey !== null && state.threadKey === threadKey;
  const open = useCallback(() => {
    if (threadKey === null) return;
    if (!enabled) {
      toastManager.add({
        type: "warning",
        title: "Thread search is unavailable on this server.",
        description: "Update the server to enable it.",
      });
      return;
    }
    const start =
      state.threadKey === threadKey && state.query.trim()
        ? findPositionReaderRef.current?.(state.query.trim())
        : undefined;
    setState((previous) => {
      const current = previous.threadKey === threadKey ? previous : CLOSED_FIND;
      return {
        ...current,
        threadKey,
        focusRequestId: previous.focusRequestId + 1,
        ...(current.query.trim()
          ? {
              start,
              offset: 0,
              localSelection: null,
              navigationId: current.navigationId + 1,
              requestId: current.navigationId + 1,
            }
          : {}),
      };
    });
  }, [enabled, state.query, state.threadKey, threadKey]);
  const close = useCallback(() => setState(CLOSED_FIND), []);
  useEffect(() => subscribeThreadFindOpen(open), [open]);

  const remote = useServerResults(
    isOpen ? thread : null,
    state.query,
    state.offset,
    state.requestId,
    state.start,
  );
  const status: "loading" | "error" | null = remote.error
    ? "error"
    : remote.isPending && remote.data === null
      ? "loading"
      : null;
  const localSelection = rebaseLocalSelection(
    state.localSelection,
    remote.data,
    remote.navigationId,
  );
  const count = remote.data?.totalMatches ?? 0;
  const activeIndex = localSelection?.activeIndex ?? remote.data?.activeIndex ?? 0;
  const selectedMatch = localSelection?.match ?? remote.data?.match;
  const entryId = selectedMatch?.entryId;
  const occurrence = selectedMatch?.occurrence;
  // Finishing the count must not rerender the timeline or request another jump.
  const match = useMemo(
    () => (entryId !== undefined && occurrence !== undefined ? { entryId, occurrence } : null),
    [entryId, occurrence],
  );
  const navigationId = localSelection?.navigationId ?? remote.navigationId;
  const step = (delta: number) => {
    if (count === 0) return;
    setState((previous) => {
      const local = rebaseLocalSelection(previous.localSelection, remote.data, remote.navigationId);
      const pending = previous.navigationId !== (local?.navigationId ?? remote.navigationId);
      const selected = local?.match ?? remote.data?.match;
      const nextIndex = stepThreadFindIndex(
        local?.activeIndex ?? remote.data?.activeIndex ?? 0,
        count,
        delta,
      );
      const entry = remote.data?.navigation?.find(
        (entry) => nextIndex >= entry.startIndex && nextIndex < entry.startIndex + entry.count,
      );
      const nextNavigationId = previous.navigationId + 1;
      if (
        !pending &&
        !remote.isPending &&
        entry &&
        remote.data &&
        (!local ||
          local.base === remote.data ||
          remote.data.navigation?.some(
            (entry) =>
              entry.entryId === local.match.entryId && local.match.occurrence < entry.count,
          )) &&
        refreshTimerRef.current === null &&
        lastContentRef.current === contentVersion
      ) {
        return {
          ...previous,
          navigationId: nextNavigationId,
          localSelection: {
            base: remote.data,
            baseNavigationId: remote.navigationId,
            activeIndex: nextIndex,
            match: {
              entryId: entry.entryId,
              occurrence: nextIndex - entry.startIndex,
            },
            navigationId: nextNavigationId,
          },
        };
      }
      return {
        ...previous,
        start:
          pending || !selected
            ? previous.start
            : { entryId: selected.entryId, occurrence: selected.occurrence },
        offset: pending ? previous.offset + delta : delta,
        navigationId: nextNavigationId,
        requestId: nextNavigationId,
      };
    });
  };

  // Refresh at most once per 300 ms, even while tokens continue arriving.
  // An identity anchor keeps newly inserted matches from shifting the selection.
  const refreshLiveResultsRef = useRef(() => {});
  useLayoutEffect(() => {
    refreshLiveResultsRef.current = () => {
      if (!isOpen || !state.query.trim()) return;
      if (!match || state.navigationId !== navigationId) {
        remote.refresh();
        return;
      }
      const start = { entryId: match.entryId, occurrence: match.occurrence };
      if (
        state.offset === 0 &&
        state.start?.entryId === start.entryId &&
        state.start.occurrence === start.occurrence &&
        state.requestId === state.navigationId
      ) {
        remote.refresh();
      } else {
        setState((previous) => ({
          ...previous,
          start,
          offset: 0,
          requestId: previous.navigationId,
        }));
      }
    };
  });
  useEffect(() => {
    if (lastContentRef.current === contentVersion) return;
    lastContentRef.current = contentVersion;
    if (!isOpen || !state.query.trim() || refreshTimerRef.current !== null) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      refreshLiveResultsRef.current();
    }, 300);
  }, [contentVersion, isOpen, state.query]);
  useEffect(() => {
    if (!isOpen || threadKey === null || !state.query.trim()) return;
    return () => {
      if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    };
  }, [threadKey, isOpen, state.query]);

  const findExpanded = isOpen && state.query.trim().length > 0;
  const findQuery = isOpen && remote.data?.match ? state.query : "";
  const timelineProps = useMemo(
    () => ({
      findOpen: isOpen,
      // Keep folds open between keystrokes while the next result loads.
      findExpanded,
      findPositionReaderRef,
      findQuery,
      activeFindMatch: match,
      findNavigationId: navigationId,
    }),
    [isOpen, findExpanded, findQuery, match, navigationId],
  );

  return {
    isOpen,
    open,
    close,
    barProps: {
      open: isOpen,
      query: state.query,
      matchCount: count,
      activeIndex,
      status,
      focusRequestId: state.focusRequestId,
      onRetry: remote.refresh,
      onQueryChange: (query: string) => {
        const start = findPositionReaderRef.current?.(query.trim());
        setState((previous) => ({
          ...previous,
          query,
          offset: 0,
          start,
          localSelection: null,
          navigationId: previous.navigationId + 1,
          requestId: previous.navigationId + 1,
        }));
      },
      onNext: () => step(1),
      onPrevious: () => step(-1),
      onClose: close,
    },
    timelineProps,
  };
}

/** A response for an older anchor can update counts without undoing newer local steps. */
function rebaseLocalSelection(
  selection: typeof CLOSED_FIND.localSelection,
  data: OrchestrationSearchThreadResult | null,
  navigationId: number,
) {
  if (!selection || !data) return null;
  if (selection.base === data && selection.baseNavigationId === navigationId) return selection;
  if (navigationId >= selection.navigationId) return null;
  const entry = data.navigation?.find((entry) => entry.entryId === selection.match.entryId);
  if (!entry || selection.match.occurrence >= entry.count) return selection;
  const activeIndex = entry.startIndex + selection.match.occurrence;
  return activeIndex === selection.activeIndex ? selection : { ...selection, activeIndex };
}

/** Query atoms cancel obsolete requests; navigation retains only the current query's result. */
function useServerResults(
  thread: ScopedThreadRef | null,
  query: string,
  offset: number,
  navigationId: number,
  start: ThreadFindStart | undefined,
) {
  const normalizedQuery = query.trim();
  const debouncedQuery = useDebouncedValue(normalizedQuery, 100);
  const environmentId = thread?.environmentId;
  const threadId = thread?.threadId;
  const atom = useMemo(
    () =>
      environmentId && threadId && debouncedQuery && normalizedQuery === debouncedQuery
        ? orchestrationEnvironment.threadFind({
            environmentId,
            input: {
              threadId,
              query: debouncedQuery,
              ...(start ? { start } : {}),
              ...(offset !== 0 ? { offset } : {}),
            },
          })
        : null,
    [environmentId, threadId, debouncedQuery, normalizedQuery, start, offset],
  );
  const result = useEnvironmentQuery(atom);
  const key = thread
    ? JSON.stringify([thread.environmentId, thread.threadId, normalizedQuery])
    : null;
  const [previous, setPrevious] = useState({
    key,
    data: result.data,
    navigationId,
  });
  if (
    previous.key !== key ||
    (result.data !== null &&
      !result.isPending &&
      (previous.data !== result.data || previous.navigationId !== navigationId))
  ) {
    const response = result.data;
    setPrevious({
      key,
      data: response,
      navigationId,
    });
  }
  return {
    ...result,
    data: key === previous.key && !result.error ? previous.data : null,
    navigationId: previous.navigationId,
    isPending:
      thread !== null &&
      normalizedQuery.length > 0 &&
      (normalizedQuery !== debouncedQuery || result.isPending),
  };
}
