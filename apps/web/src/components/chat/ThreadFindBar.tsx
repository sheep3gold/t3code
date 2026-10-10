import { useEffect, useRef, type KeyboardEvent } from "react";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { cn } from "~/lib/utils";
import { formatThreadFindCount } from "./threadFind";

interface ThreadFindBarProps {
  readonly open: boolean;
  readonly query: string;
  readonly matchCount: number;
  readonly status: "loading" | "error" | null;
  readonly onRetry: () => void;
  readonly activeIndex: number;
  readonly focusRequestId: number;
  readonly onQueryChange: (query: string) => void;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  readonly onClose: () => void;
}

/**
 * Room the open bar takes at the top of the chat column: its `h-9` height plus
 * the 12px gap below it, so anything avoiding the bar stays on the same rhythm.
 */
export const THREAD_FIND_BAR_RESERVED_HEIGHT = 36 + 12;

export function ThreadFindBar(props: ThreadFindBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!props.open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [props.focusRequestId, props.open]);

  if (!props.open) return null;

  const hasQuery = props.query.trim().length > 0;
  const noResults = hasQuery && !props.status && props.matchCount === 0;
  let label = "";
  if (hasQuery) {
    label = formatThreadFindCount(props.activeIndex, props.matchCount);
  }
  if (props.status === "loading") label = "Searching…";
  if (props.status === "error") label = "Search failed";
  const navigationDisabled = props.matchCount === 0 || props.status === "loading";
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) props.onPrevious();
      else props.onNext();
    }
  };

  return (
    <InputGroup
      variant="default"
      onContextMenu={(event) => event.stopPropagation()}
      role="search"
      aria-label="Find in thread"
      aria-busy={props.status === "loading"}
      className="absolute top-3 right-3 z-40 w-[min(24rem,calc(100%-1.5rem))] shadow-md"
    >
      <InputGroupInput
        ref={inputRef}
        type="search"
        size="sm"
        value={props.query}
        aria-label="Find in thread"
        placeholder="Find in thread"
        maxLength={200}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => props.onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <InputGroupAddon align="inline-end">
        <span
          aria-live="polite"
          className={cn(
            "min-w-10 text-center text-xs tabular-nums",
            noResults ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {label}
        </span>
        {props.status === "error" ? (
          <Button size="xs" variant="ghost" onClick={props.onRetry}>
            Retry
          </Button>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Previous match"
          disabled={navigationDisabled}
          onClick={props.onPrevious}
        >
          <ChevronUpIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Next match"
          disabled={navigationDisabled}
          onClick={props.onNext}
        >
          <ChevronDownIcon />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Close find" onClick={props.onClose}>
          <XIcon />
        </Button>
      </InputGroupAddon>
    </InputGroup>
  );
}
