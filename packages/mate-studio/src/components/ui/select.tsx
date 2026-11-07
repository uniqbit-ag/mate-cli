import { Select as SelectPrimitive } from "@base-ui/react/select";

import { cn } from "../../lib/cn";
import { Icon } from "../icon";

/** A dropdown field, framed like `Input`; its chevron sits inset from the right edge. */
const TRIGGER =
  "relative flex h-9 w-full min-w-0 items-center gap-2 rounded-control border border-rule bg-page pr-9 pl-3 text-left text-sm text-text outline-none transition-colors focus-visible:border-accent data-popup-open:border-accent disabled:cursor-not-allowed disabled:opacity-60";
const CHEVRON = "pointer-events-none size-4 text-muted";
/** The open list, styled like `PopoverContent`, at least as wide as its field. */
const POPUP =
  "max-h-[min(var(--available-height),20rem)] min-w-(--anchor-width) overflow-y-auto rounded-card border border-rule bg-surface p-1 text-text shadow-float outline-none transition-[opacity,transform] duration-150 data-ending-style:-translate-y-1 data-ending-style:opacity-0 data-starting-style:-translate-y-1 data-starting-style:opacity-0";
const ITEM =
  "relative flex cursor-default items-center rounded-[6px] py-1.5 pr-8 pl-2.5 text-sm outline-none select-none data-disabled:opacity-50 data-highlighted:bg-accent-soft";
const ITEM_CHECK = "pointer-events-none absolute right-2.5 size-4 text-accent";

function Select<Value>(props: SelectPrimitive.Root.Props<Value>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectTrigger({ className, children, ...props }: SelectPrimitive.Trigger.Props) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(TRIGGER, className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="absolute right-3 flex">
        <Icon name="chevron" className={CHEVRON} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("truncate", className)}
      {...props}
    />
  );
}

function SelectContent({ className, ...props }: SelectPrimitive.Popup.Props) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner alignItemWithTrigger={false} sideOffset={6} className="z-40">
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(POPUP, className)}
          {...props}
        />
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item data-slot="select-item" className={cn(ITEM, className)} {...props}>
      <SelectPrimitive.ItemText className="truncate">{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className={ITEM_CHECK}>
        <Icon name="check" className="size-4" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export {
  CHEVRON,
  ITEM,
  ITEM_CHECK,
  POPUP,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TRIGGER,
};
