import { Input as InputPrimitive } from "@base-ui/react/input";
import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

/** A key name, as the viewer presses it. */
function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-grid h-[18px] min-w-[18px] place-items-center rounded-[4px] border border-b-2 border-rule bg-page px-1 font-mono text-[0.66rem] leading-none font-semibold text-muted select-none",
        className,
      )}
      {...props}
    />
  );
}

const FIELD =
  "w-full min-w-0 rounded-control border border-rule bg-page px-3 text-sm text-text outline-none transition-colors placeholder:text-muted focus:border-accent disabled:cursor-not-allowed disabled:opacity-60";

function Input({ className, ...props }: ComponentProps<"input">) {
  return <InputPrimitive data-slot="input" className={cn(FIELD, "h-9", className)} {...props} />;
}

function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(FIELD, "min-h-20 py-2 leading-relaxed", className)}
      {...props}
    />
  );
}

function Separator({ className, orientation = "horizontal", ...props }: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-rule-soft data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch",
        className,
      )}
      {...props}
    />
  );
}

export { Input, Kbd, Separator, Textarea };
