import { cn } from "../lib/cn";

/** Line icons on a 20px grid, drawn locally so the page loads nothing from another host. */
const PATHS = {
  home: "M3 10.5 10 4l7 6.5M5 9v7h4v-4h2v4h4V9",
  flow: "M6 4v4m0 4v4M6 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 0h5a3 3 0 0 1 3 3v1m0 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z",
  spark: "M10 3v3m0 8v3M3 10h3m8 0h3M5.5 5.5l2 2m5 5 2 2m0-9-2 2m-5 5-2 2",
  doc: "M6 3h5l4 4v10H6zM11 3v4h4M8.5 11h4M8.5 14h4",
  folder: "M3 6.5V15h14V8H9.5L8 6H3.5",
  chart: "M4 16V9m4 7V5m4 11v-5m4 5V8",
  // Three nodes and the edges between them.
  graph:
    "M3 6a2 2 0 1 0 4 0 2 2 0 1 0-4 0m10-1a2 2 0 1 0 4 0 2 2 0 1 0-4 0m-5 10a2 2 0 1 0 4 0 2 2 0 1 0-4 0M7 5.8l6-.6M5.7 7.9l3.6 5.3m5-6.3-3.4 6.3",
  search: "M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12Zm4.5-1.5L17 17",
  chevron: "m7 8 3 3 3-3",
  right: "m8 6 4 4-4 4",
  left: "m12 6-4 4 4 4",
  close: "m6 6 8 8m0-8-8 8",
  copy: "M7 7V4h9v9h-3M4 7h9v9H4z",
  refresh: "M16 10a6 6 0 1 1-1.8-4.3M16 4v3h-3",
  theme: "M10 3a7 7 0 1 0 7 7 5 5 0 0 1-7-7Z",
  terminal: "M3 4h14v12H3zM6 8l2.5 2L6 12m4 0h4",
  check: "m5 10.5 3 3 7-7",
  play: "M7 5v10l8-5z",
  factory: "M3 17V9l4 2.5V9l4 2.5V5h3l1 12zM3 17h14",
  plus: "M10 4v12M4 10h12",
  external: "M11 4h5v5M16 4l-7 7M14 12v4H4V6h4",
  sidebar: "M3 4h14v12H3zM8 4v12",
  code: "m7 6-4 4 4 4m6-8 4 4-4 4",
  eye: "M2.5 10S5 4.5 10 4.5 17.5 10 17.5 10 15 15.5 10 15.5 2.5 10 2.5 10Zm7.5 2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  pencil: "m12.5 4.5 3 3L7 16H4v-3zM11 6l3 3",
  // Three round dots: zero-length segments drawn by the round line cap.
  more: "M5 10h.01M10 10h.01M15 10h.01",
  trash: "M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10M9 9v4m2-4v4",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={cn(
        "size-4 flex-none fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.6]",
        className,
      )}
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
