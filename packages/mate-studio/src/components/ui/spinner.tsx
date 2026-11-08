import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

function Spinner({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      className={cn("size-4 shrink-0 animate-spin motion-reduce:animate-none", className)}
      {...props}
    >
      <path d="M12 3a9 9 0 1 1-9 9" />
    </svg>
  );
}

export { Spinner };
