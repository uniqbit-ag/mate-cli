/*
 * Adapted from AI Elements (https://github.com/vercel/ai-elements), Copyright Vercel, Inc.,
 * Apache License 2.0. Changed for Studio: a checkpoint is a question already asked, and
 * restoring it drops it and everything after, putting its text back in the field to edit;
 * Studio's Button, Tooltip and icons.
 */
import { Icon } from "../icon";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";

/** Rewinds the conversation to just before this question. */
export function Checkpoint({ onRestore, disabled }: { onRestore: () => void; disabled: boolean }) {
  return (
    <Tooltip label="Edit this question and ask again from here" side="bottom">
      <Button
        aria-label="Edit and ask again from here"
        className="mt-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        data-chat-checkpoint
        disabled={disabled}
        onClick={onRestore}
        size="icon-sm"
        variant="ghost"
      >
        <Icon name="undo" className="size-3.5" />
      </Button>
    </Tooltip>
  );
}
