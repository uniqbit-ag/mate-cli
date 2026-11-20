/*
 * Adapted from AI Elements (https://github.com/vercel/ai-elements), Copyright Vercel, Inc.,
 * Apache License 2.0. Changed for Studio: Base UI's Select instead of a command dialog (the
 * lists are short), options grouped under their provider with a one-line description, a
 * compact trigger that sits in the prompt bar, and Studio's select styles.
 */
import { Select as SelectPrimitive } from "@base-ui/react/select";

import { cn } from "../../lib/cn";
import { Icon } from "../icon";
import { ITEM, ITEM_CHECK, POPUP } from "../ui/select";

export interface ModelOption<Value extends string> {
  value: Value;
  name: string;
  description?: string;
}

const TRIGGER =
  "inline-flex h-7 min-w-0 items-center gap-1 rounded-control border border-transparent px-2 text-xs text-muted outline-none transition-colors hover:border-rule hover:bg-page hover:text-text focus-visible:border-accent data-popup-open:border-rule data-popup-open:bg-page data-popup-open:text-text disabled:pointer-events-none disabled:opacity-50";

/** A compact choice in the prompt bar, such as the model or its effort. */
export function ModelSelector<Value extends string>({
  label,
  group,
  options,
  value,
  onChange,
  disabled = false,
  prefix,
  className,
}: {
  /** What the choice is, for assistive tech and the list's heading. */
  label: string;
  /** Who offers the options, shown above them, such as the provider. */
  group?: string;
  options: readonly ModelOption<Value>[];
  value: Value;
  onChange: (value: Value) => void;
  disabled?: boolean;
  /** Shown before the chosen option's name in the trigger, such as "Effort". */
  prefix?: string;
  className?: string;
}) {
  const chosen = options.find((option) => option.value === value);
  return (
    <SelectPrimitive.Root
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
      value={value}
    >
      <SelectPrimitive.Trigger aria-label={label} className={cn(TRIGGER, className)}>
        {prefix ? <span>{prefix}</span> : null}
        <span className="truncate font-medium text-text">{chosen?.name ?? value}</span>
        <SelectPrimitive.Icon className="flex">
          <Icon name="chevron" className="size-3.5" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          align="start"
          alignItemWithTrigger={false}
          className="z-40"
          side="top"
          sideOffset={6}
        >
          <SelectPrimitive.Popup className={cn(POPUP, "w-64")}>
            <SelectPrimitive.Group>
              <SelectPrimitive.GroupLabel className="px-2.5 pt-1 pb-1.5 text-2xs font-semibold text-muted">
                {group ?? label}
              </SelectPrimitive.GroupLabel>
              {options.map((option) => (
                <SelectPrimitive.Item
                  className={cn(ITEM, "items-start")}
                  key={option.value}
                  value={option.value}
                >
                  <span className="grid min-w-0 gap-0.5">
                    <SelectPrimitive.ItemText className="truncate font-medium">
                      {option.name}
                    </SelectPrimitive.ItemText>
                    {option.description ? (
                      <span className="text-2xs text-muted">{option.description}</span>
                    ) : null}
                  </span>
                  <SelectPrimitive.ItemIndicator className={cn(ITEM_CHECK, "top-2")}>
                    <Icon name="check" className="size-4" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Group>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
