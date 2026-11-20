/*
 * Adapted from AI Elements (https://github.com/vercel/ai-elements), Copyright Vercel, Inc.,
 * Apache License 2.0. Changed for Studio: a text-only form (no attachments or menus) with a
 * toolbar for the model picker, Studio's Button, Textarea, Kbd, icons and colour tokens, a
 * field that grows with its text, and Enter to send with Shift+Enter for a new line.
 */
import type { ChatStatus } from "ai";
import type { ComponentProps, FormEvent, KeyboardEvent } from "react";

import { cn } from "../../lib/cn";
import { Icon } from "../icon";
import { Button } from "../ui/button";
import { Kbd, Textarea } from "../ui/fields";

export function PromptInput({
  className,
  onSubmit,
  ...props
}: Omit<ComponentProps<"form">, "onSubmit"> & {
  /** False when the text was not sent, so the field keeps it. */
  onSubmit: (text: string) => boolean;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const field = event.currentTarget.elements.namedItem("message");
    if (!(field instanceof HTMLTextAreaElement)) return;
    const text = field.value.trim();
    if (!text) return;
    if (onSubmit(text)) field.value = "";
  };
  return (
    <form
      className={cn(
        "flex w-full flex-col gap-1 rounded-card border border-rule bg-surface p-2 transition-colors focus-within:border-accent",
        className,
      )}
      onSubmit={submit}
      {...props}
    />
  );
}

export function PromptInputTextarea({
  className,
  onKeyDown,
  ...props
}: ComponentProps<"textarea">) {
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };
  return (
    <Textarea
      name="message"
      rows={1}
      className={cn(
        "field-sizing-content max-h-48 min-h-10 w-full resize-none border-0 bg-transparent px-1.5 py-1.5 text-md",
        className,
      )}
      onKeyDown={keyDown}
      {...props}
    />
  );
}

/** The row under the field: choices on the left, `PromptInputSubmit` on the right. */
export function PromptInputToolbar({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex items-center justify-between gap-2", className)} {...props} />;
}

export function PromptInputTools({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex min-w-0 items-center gap-0.5", className)} {...props} />;
}

/** The keys the field answers to. */
export function PromptInputHint({ className, ...props }: ComponentProps<"p">) {
  return (
    <p className={cn("m-0 flex items-center gap-1 text-2xs text-muted", className)} {...props}>
      <Kbd>Enter</Kbd> to send · <Kbd>Shift</Kbd>
      <Kbd>Enter</Kbd> for a new line
    </p>
  );
}

/** Sends while idle; stops the answer while one is coming. */
export function PromptInputSubmit({
  status,
  onStop,
  className,
  ...props
}: ComponentProps<typeof Button> & { status: ChatStatus; onStop: () => void }) {
  const busy = status === "submitted" || status === "streaming";
  return busy ? (
    <Button
      aria-label="Stop the answer"
      className={className}
      onClick={onStop}
      size="icon"
      type="button"
      {...props}
    >
      <Icon name="stop" />
    </Button>
  ) : (
    <Button
      aria-label="Send"
      className={className}
      size="icon"
      type="submit"
      variant="primary"
      {...props}
    >
      <Icon name="send" />
    </Button>
  );
}
