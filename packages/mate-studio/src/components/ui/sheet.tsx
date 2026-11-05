import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";

import { cn } from "../../lib/cn";

function Sheet(props: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

const SheetClose = SheetPrimitive.Close;

/** A panel floating over the page from the right edge; it alone casts the floating shadow. */
function SheetContent({
  className,
  wide = false,
  ...props
}: SheetPrimitive.Popup.Props & { wide?: boolean }) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Backdrop
        data-slot="sheet-overlay"
        className="fixed inset-0 z-30 bg-[color-mix(in_srgb,var(--bg)_45%,transparent)] transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0"
      />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-wide={wide ? "" : undefined}
        className={cn(
          "fixed top-2 right-2 bottom-2 z-30 flex w-[min(560px,calc(100vw-16px))] flex-col overflow-hidden rounded-panel border border-rule bg-surface text-text shadow-float outline-none transition-[transform,width] duration-250 ease-[cubic-bezier(.16,1,.3,1)] data-ending-style:translate-x-[calc(100%+16px)] data-starting-style:translate-x-[calc(100%+16px)] data-wide:w-[min(760px,calc(100vw-16px))]",
          className,
        )}
        {...props}
      />
    </SheetPrimitive.Portal>
  );
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("m-0 text-lg font-semibold break-words", className)}
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("m-0 text-sm text-muted", className)}
      {...props}
    />
  );
}

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle };
