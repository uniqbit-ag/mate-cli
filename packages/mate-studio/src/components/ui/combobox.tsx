import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";

import { cn } from "../../lib/cn";
import { Icon } from "../icon";
import { CHEVRON, ITEM, ITEM_CHECK, POPUP, TRIGGER } from "./select";

const Combobox = ComboboxPrimitive.Root;

/** A typing field framed like the Select trigger, with the same inset chevron. */
function ComboboxInput({ className, ...props }: ComboboxPrimitive.Input.Props) {
  return (
    <ComboboxPrimitive.InputGroup
      data-slot="combobox-input-group"
      className={cn("relative flex items-center", className)}
    >
      <ComboboxPrimitive.Input
        data-slot="combobox-input"
        className={cn(TRIGGER, "placeholder:text-muted focus:border-accent")}
        {...props}
      />
      <ComboboxPrimitive.Trigger
        data-slot="combobox-trigger"
        aria-label="Show options"
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center outline-none"
      >
        <Icon name="chevron" className={CHEVRON} />
      </ComboboxPrimitive.Trigger>
    </ComboboxPrimitive.InputGroup>
  );
}

function ComboboxContent({ className, ...props }: ComboboxPrimitive.Popup.Props) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner sideOffset={6} className="z-40">
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(POPUP, className)}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

const ComboboxList = ComboboxPrimitive.List;

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn("px-2.5 py-1.5 text-sm text-muted empty:hidden", className)}
      {...props}
    />
  );
}

function ComboboxItem({ className, children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item data-slot="combobox-item" className={cn(ITEM, className)} {...props}>
      <span className="truncate">{children}</span>
      <ComboboxPrimitive.ItemIndicator className={ITEM_CHECK}>
        <Icon name="check" className="size-4" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  );
}

export { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList };
