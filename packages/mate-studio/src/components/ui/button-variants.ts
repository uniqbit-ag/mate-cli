import { cva } from "class-variance-authority";

/** The button look, also for links that act as buttons. */
export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-control border font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none",
  {
    variants: {
      variant: {
        default: "border-rule bg-surface text-text hover:border-accent hover:bg-accent-soft",
        primary:
          "border-accent bg-accent-soft font-semibold text-text hover:bg-accent hover:text-on-accent",
        ghost:
          "border-transparent bg-transparent text-muted hover:border-rule hover:bg-surface hover:text-text",
        link: "border-transparent bg-transparent px-0 text-accent underline-offset-3 hover:underline",
        danger: "border-bad bg-bad-soft font-semibold text-bad hover:bg-bad hover:text-page",
      },
      size: {
        default: "h-8 px-3 text-sm",
        sm: "h-7 px-2.5 text-xs",
        icon: "size-8",
        "icon-sm": "size-7",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);
