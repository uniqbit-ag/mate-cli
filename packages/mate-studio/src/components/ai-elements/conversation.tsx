/*
 * Adapted from AI Elements (https://github.com/vercel/ai-elements), Copyright Vercel, Inc.,
 * Apache License 2.0. Changed for Studio: Studio's Button and icons instead of lucide-react,
 * Studio's colour tokens, and Studio's own empty state.
 */
import type { ComponentProps, ReactNode } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

import { cn } from "../../lib/cn";
import { Icon } from "../icon";
import { Button } from "../ui/button";

/** The scrolling message log; it follows new text unless the reader scrolled up. */
export function Conversation({ className, ...props }: ComponentProps<typeof StickToBottom>) {
  return (
    <StickToBottom
      className={cn("relative min-h-0 flex-1 overflow-y-hidden", className)}
      initial="smooth"
      resize="smooth"
      role="log"
      {...props}
    />
  );
}

export function ConversationContent({
  className,
  ...props
}: ComponentProps<typeof StickToBottom.Content>) {
  return (
    <StickToBottom.Content
      className={cn("mx-auto flex w-full max-w-[72ch] flex-col gap-6 px-1 py-4", className)}
      {...props}
    />
  );
}

/** What a new conversation can start from; the page header already names the view. */
export function ConversationEmptyState({
  className,
  description,
  children,
  ...props
}: ComponentProps<"div"> & { description: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-4 pt-[12vh]", className)} {...props}>
      <p className="m-0 max-w-[60ch] text-md text-muted">{description}</p>
      {children}
    </div>
  );
}

/** Shown while the reader is above the newest message. */
export function ConversationScrollButton({ className, ...props }: ComponentProps<typeof Button>) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <Button
      aria-label="Scroll to the newest message"
      className={cn(
        "absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-float",
        className,
      )}
      onClick={() => void scrollToBottom()}
      size="icon"
      {...props}
    >
      <Icon name="down" />
    </Button>
  );
}
