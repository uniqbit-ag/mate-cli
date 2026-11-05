import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";

import { cn } from "../../lib/cn";

/** A row of toggle buttons; `pill` filters a list, `segment` picks one of a few modes. */
function ToggleGroup({ className, ...props }: ToggleGroupPrimitive.Props) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      {...props}
    />
  );
}

const ITEM = {
  pill: "inline-flex h-7 items-center gap-2 rounded-control border border-rule bg-transparent px-3 text-sm text-muted transition-colors hover:border-accent hover:text-text data-pressed:border-accent data-pressed:bg-accent-soft data-pressed:font-semibold data-pressed:text-text",
  segment:
    "inline-flex h-7 items-center justify-center gap-1.5 rounded-[6px] border-0 bg-transparent px-2 text-xs text-muted transition-colors hover:text-text data-pressed:bg-surface data-pressed:font-semibold data-pressed:text-text data-pressed:ring-1 data-pressed:ring-rule disabled:cursor-not-allowed disabled:line-through disabled:opacity-60",
} as const;

function ToggleGroupItem({
  className,
  look = "pill",
  ...props
}: TogglePrimitive.Props & { look?: keyof typeof ITEM }) {
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(ITEM[look], className)}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };
