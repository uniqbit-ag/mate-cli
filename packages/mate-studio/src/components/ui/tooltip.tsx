import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

import { cn } from "../../lib/cn";

function TooltipProvider({ delay = 250, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider delay={delay} {...props} />;
}

/** A short label beside its trigger; `disabled` keeps the trigger without the tooltip. */
function Tooltip({
  label,
  children,
  side = "right",
  disabled = false,
  className,
}: {
  label: ReactNode;
  children: ReactElement;
  side?: TooltipPrimitive.Positioner.Props["side"];
  disabled?: boolean;
  className?: string;
}) {
  return (
    <TooltipPrimitive.Root disabled={disabled}>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} sideOffset={8} className="z-50">
          <TooltipPrimitive.Popup
            data-slot="tooltip-content"
            className={cn(
              "rounded-[6px] border border-rule bg-surface px-2.5 py-1 text-xs text-text shadow-float transition-opacity duration-100 data-ending-style:opacity-0 data-starting-style:opacity-0",
              className,
            )}
          >
            {label}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export { Tooltip, TooltipProvider };
