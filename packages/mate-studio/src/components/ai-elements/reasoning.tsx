/*
 * Adapted from AI Elements (https://github.com/vercel/ai-elements), Copyright Vercel, Inc.,
 * Apache License 2.0. Changed for Studio: Base UI's Collapsible instead of Radix, no duration
 * (the harness reports none), Studio's icons, spinner and colour tokens, and the reasoning as
 * plain text.
 */
import { Collapsible } from "@base-ui/react/collapsible";
import { useState } from "react";

import { cn } from "../../lib/cn";
import { Icon } from "../icon";
import { Spinner } from "../ui/spinner";

/**
 * The model's summarized thinking before an answer: open while it streams, folded once the
 * answer moves on, unless the reader opened or closed it.
 */
export function Reasoning({
  text,
  streaming,
  className,
}: {
  text: string;
  streaming: boolean;
  className?: string;
}) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  return (
    <Collapsible.Root
      className={cn("w-full", className)}
      data-chat-reasoning
      onOpenChange={setChosen}
      open={chosen ?? streaming}
    >
      <Collapsible.Trigger className="group/reasoning inline-flex items-center gap-1.5 rounded-control py-0.5 text-xs text-muted transition-colors hover:text-text">
        {streaming ? (
          <Spinner aria-hidden="true" role={undefined} className="size-3.5 text-accent" />
        ) : (
          <Icon name="spark" className="size-3.5" />
        )}
        {streaming ? "Thinking…" : "Reasoning"}
        <Icon
          name="chevron"
          className="size-3.5 transition-transform group-data-[panel-open]/reasoning:rotate-180"
        />
      </Collapsible.Trigger>
      <Collapsible.Panel className="mt-1.5 max-h-72 overflow-y-auto border-l border-rule pl-3 text-sm leading-relaxed whitespace-pre-wrap text-muted">
        {text}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
