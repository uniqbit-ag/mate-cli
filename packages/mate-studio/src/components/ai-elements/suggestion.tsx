/*
 * Adapted from AI Elements (https://github.com/vercel/ai-elements), Copyright Vercel, Inc.,
 * Apache License 2.0. Changed for Studio: wrapped rows instead of a horizontal scroller,
 * Studio's Button with control corners rather than pills, and an arrow that names the action.
 */
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";
import { Icon } from "../icon";
import { Button } from "../ui/button";

export function Suggestions({ className, ...props }: ComponentProps<"ul">) {
  return (
    <ul
      className={cn("m-0 flex list-none flex-col items-start gap-1.5 p-0", className)}
      {...props}
    />
  );
}

/** A question that sends as it reads. */
export function Suggestion({
  suggestion,
  onAsk,
  className,
}: {
  suggestion: string;
  onAsk: (suggestion: string) => void;
  className?: string;
}) {
  return (
    <li className="max-w-full">
      <Button
        className={cn(
          "group/suggestion h-auto max-w-full justify-start gap-2 py-2 text-left text-sm font-normal whitespace-normal",
          className,
        )}
        onClick={() => onAsk(suggestion)}
      >
        {suggestion}
        <Icon
          name="right"
          className="size-3.5 text-muted transition-transform group-hover/suggestion:translate-x-0.5 group-hover/suggestion:text-accent"
        />
      </Button>
    </li>
  );
}
