import {
  createContext,
  use,
  useEffect,
  useImperativeHandle,
  type ReactNode,
  type Ref,
} from "react";
import { useThreadFind } from "./useThreadFind";
import { ThreadFindBar } from "./ThreadFindBar";

type Find = ReturnType<typeof useThreadFind>;
export type ThreadFindControls = Pick<Find, "open" | "close">;
export const ThreadFindTimelineContext = createContext<Find["timelineProps"] | null>(null);
const ThreadFindBarContext = createContext<Find["barProps"] | null>(null);

/** Owns search updates below the chat view so cycling does not rerender the composer and panels. */
export function ThreadFindProvider({
  controlsRef,
  onOpenChange,
  children,
  ...options
}: Parameters<typeof useThreadFind>[0] & {
  controlsRef: Ref<ThreadFindControls>;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const find = useThreadFind(options);
  useImperativeHandle(controlsRef, () => ({ open: find.open, close: find.close }), [
    find.open,
    find.close,
  ]);
  useEffect(() => onOpenChange(find.isOpen), [find.isOpen, onOpenChange]);
  return (
    <ThreadFindBarContext value={find.barProps}>
      <ThreadFindTimelineContext value={find.timelineProps}>{children}</ThreadFindTimelineContext>
    </ThreadFindBarContext>
  );
}

export function ThreadFind({ onClose }: { onClose: () => void }) {
  const bar = use(ThreadFindBarContext);
  if (!bar) return null;
  return (
    <ThreadFindBar
      {...bar}
      onClose={() => {
        bar.onClose();
        onClose();
      }}
    />
  );
}
