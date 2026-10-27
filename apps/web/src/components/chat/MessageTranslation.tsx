import { use } from "react";
import { LanguagesIcon } from "lucide-react";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { TimelineRowCtx } from "./timelineRowContext";
import { MESSAGE_HEADING_LEVEL } from "./TimelineRowParts";

// Translation into Chinese, requested per message via the 译 button in the
// row's action area. The translation renders under the source text; failures
// leave the row without a translation rather than showing an error.
export function MessageTranslationBlock({
  messageId,
  align,
}: {
  messageId: string;
  align: "start" | "end";
}) {
  const ctx = use(TimelineRowCtx);
  const translation = ctx.translationForMessage(messageId);
  if (!translation) return null;
  return (
    <div
      className={cn(
        "mt-1.5 rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 text-sm text-muted-foreground",
        align === "end" ? "w-full max-w-[80%] self-end text-start" : undefined,
      )}
      data-message-translation={messageId}
    >
      <ChatMarkdown
        text={translation}
        cwd={ctx.markdownCwd}
        threadRef={ctx.threadRef ?? undefined}
        isStreaming={false}
        lineBreaks={false}
        skills={ctx.skills}
        headingLevelOffset={MESSAGE_HEADING_LEVEL}
        onUseArtifactTemplate={ctx.onUseArtifactTemplate}
        onImageExpand={ctx.onImageExpand}
      />
    </div>
  );
}

// Per-message translate trigger. Hidden once the translation landed or while
// the server has no translation upstream; spins while its request is in
// flight. Rendered in the same hover-revealed action row as copy/revert.
export function MessageTranslateButton({ messageId }: { messageId: string }) {
  const ctx = use(TimelineRowCtx);
  if (!ctx.translationAvailable) return null;
  if (ctx.translationForMessage(messageId) !== undefined) return null;
  const pending = ctx.translationPendingFor(messageId);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={pending}
            onClick={() => ctx.onTranslateMessage(messageId)}
            aria-label="翻译为中文"
          />
        }
      >
        {pending ? (
          <Spinner className="size-3" aria-hidden />
        ) : (
          <LanguagesIcon className="size-3" aria-hidden />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">翻译为中文</TooltipPopup>
    </Tooltip>
  );
}
