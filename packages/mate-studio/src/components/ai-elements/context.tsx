/*
 * Adapted from AI Elements (https://github.com/vercel/ai-elements), Copyright Vercel, Inc.,
 * Apache License 2.0. Changed for Studio: the history the next question replays, in
 * characters, instead of the model's tokens (each question is a fresh session, so the history
 * is what fills its context); a thin bar and a tooltip instead of a ring and a hover card.
 */
import { cn } from "../../lib/cn";
import { Tooltip } from "../ui/tooltip";

const NUMBER = new Intl.NumberFormat("en");

/** How much of the replay budget the conversation so far takes. */
export function Context({
  used,
  budget,
  className,
}: {
  used: number;
  budget: number;
  className?: string;
}) {
  if (used === 0) return null;
  const share = Math.min(1, used / budget);
  const percent = Math.round(share * 100);
  const full = used >= budget;
  return (
    <Tooltip
      label={
        <span className="block max-w-64">
          The next question replays {NUMBER.format(used)} of {NUMBER.format(budget)} characters of
          this conversation.
          {full ? " Older turns are cut to fit." : ""}
        </span>
      }
      side="top"
    >
      <span
        aria-label={`History: ${percent}% of what a question replays`}
        className={cn("inline-flex items-center gap-1.5 text-2xs text-muted", className)}
        data-chat-context
        role="img"
        tabIndex={0}
      >
        <span className="h-1 w-10 overflow-hidden rounded-full bg-rule">
          <span
            className={cn("block h-full rounded-full", full ? "bg-warn" : "bg-accent")}
            style={{ width: `${Math.max(4, percent)}%` }}
          />
        </span>
        <span className="font-mono tabular-nums">{percent}%</span>
      </span>
    </Tooltip>
  );
}
