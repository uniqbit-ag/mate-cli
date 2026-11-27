/*
 * Adapted from AI Elements (https://github.com/vercel/ai-elements), Copyright Vercel, Inc.,
 * Apache License 2.0. Changed for Studio: only queued questions (no todos or attachments), one
 * flat list over the prompt field, Studio's Button, icons and colour tokens.
 */
import type { ReactNode } from "react";

import { cn } from "../../lib/cn";
import { Icon } from "../icon";
import { Button } from "../ui/button";

export interface QueuedQuestion {
  id: string;
  text: string;
}

/** Questions asked while an answer was coming; each sends, in order, once the one before ends. */
export function Queue({
  items,
  onRemove,
  note,
  className,
}: {
  items: QueuedQuestion[];
  onRemove: (id: string) => void;
  /** Why the queue is not moving, such as a failed answer. */
  note?: ReactNode;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <section
      aria-label="Queued questions"
      className={cn("rounded-card border border-rule bg-page px-2 py-1.5", className)}
      data-chat-queue
    >
      <p className="m-0 flex items-center gap-1.5 px-1 pb-1 text-2xs font-semibold text-muted">
        <Icon name="queue" className="size-3.5" />
        Queued <span className="font-mono tabular-nums">{items.length}</span>
        {note ? <span className="font-normal text-warn">· {note}</span> : null}
      </p>
      <ol className="m-0 grid list-none gap-0.5 p-0">
        {items.map((item) => (
          <li
            className="group/queued flex min-w-0 items-center gap-2 rounded-control px-1 py-0.5 hover:bg-surface"
            key={item.id}
          >
            <span className="min-w-0 flex-1 truncate text-sm text-text">{item.text}</span>
            <Button
              aria-label={`Remove “${item.text}” from the queue`}
              className="opacity-0 group-hover/queued:opacity-100 focus-visible:opacity-100"
              onClick={() => onRemove(item.id)}
              size="icon-sm"
              variant="ghost"
            >
              <Icon name="close" className="size-3.5" />
            </Button>
          </li>
        ))}
      </ol>
    </section>
  );
}
