import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "../../lib/cn";

function Popover(props: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = "start",
  side = "bottom",
  sideOffset = 6,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, "align" | "side" | "sideOffset">) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        className="z-40"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "grid w-[340px] gap-0.5 rounded-card border border-rule bg-surface p-2 text-text shadow-float outline-none transition-[opacity,transform] duration-150 data-ending-style:-translate-y-1 data-ending-style:opacity-0 data-starting-style:-translate-y-1 data-starting-style:opacity-0",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      className={cn("mx-2.5 mt-1 mb-1.5 text-xs font-semibold text-muted", className)}
      {...props}
    />
  );
}

const PopoverClose = PopoverPrimitive.Close;

export { Popover, PopoverClose, PopoverContent, PopoverTitle, PopoverTrigger };
