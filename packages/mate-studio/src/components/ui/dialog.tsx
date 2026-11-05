import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

import { cn } from "../../lib/cn";

function Dialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

/** A centred dialog near the top of the window; it floats, so it casts the floating shadow. */
function DialogContent({ className, ...props }: DialogPrimitive.Popup.Props) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        data-slot="dialog-overlay"
        className="fixed inset-0 z-40 bg-[color-mix(in_srgb,var(--bg)_70%,transparent)] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0"
      />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed top-[14vh] left-1/2 z-40 w-[min(620px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-card border border-rule bg-surface text-text shadow-float outline-none transition-[opacity,transform] duration-150 data-ending-style:translate-y-1.5 data-ending-style:opacity-0 data-starting-style:translate-y-1.5 data-starting-style:opacity-0",
          className,
        )}
        {...props}
      />
    </DialogPrimitive.Portal>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("m-0 text-lg font-semibold", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("m-0 text-sm text-muted", className)}
      {...props}
    />
  );
}

export { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger };
