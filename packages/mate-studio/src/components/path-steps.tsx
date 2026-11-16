import { cn } from "../lib/cn";

/** The colour the current step takes: its state, in the Meaning-Only palette. */
export type PathTone = "accent" | "warn" | "why" | "bad";

const BAR: Record<PathTone, string> = {
  accent: "before:bg-accent",
  warn: "before:bg-warn",
  why: "before:bg-why",
  bad: "before:bg-bad",
};

const BAR_FILL: Record<PathTone, string> = {
  accent: "bg-accent",
  warn: "bg-warn",
  why: "bg-why",
  bad: "bg-bad",
};

const LABEL: Record<PathTone, string> = {
  accent: "text-text",
  warn: "text-warn",
  why: "text-why",
  bad: "text-bad",
};

/** `current` before the first step reads "Saved for later"; past the last, "Delivered". */
function CompactPath({
  steps,
  current,
  tone,
}: {
  steps: readonly string[];
  current: number;
  tone: PathTone;
}) {
  let label = `Step ${current + 1} of ${steps.length} · ${steps[current]}`;
  if (current < 0) label = "Saved for later";
  else if (current >= steps.length) label = "Delivered";
  return (
    <div className="grid gap-2" role="group" aria-label="Delivery Path">
      <p className={cn("m-0 text-xs font-semibold", current >= 0 ? LABEL[tone] : "text-muted")}>
        {label}
      </p>
      <ol
        className="m-0 grid list-none gap-1 p-0"
        style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
      >
        {steps.map((name, index) => (
          <li
            key={name}
            aria-current={index === current ? "step" : undefined}
            className={cn(
              "h-1 rounded-full bg-rule",
              index < current && "bg-[color-mix(in_srgb,var(--accent)_55%,var(--border))]",
              index === current && BAR_FILL[tone],
            )}
          >
            <span className="sr-only">{name}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Where something is on the Delivery Path, as one bar per step. Steps before `current` are
 * done, `current` is marked and takes `tone`; `current` outside the list marks none, and a
 * value past the end marks every step done.
 */
export function PathSteps({
  steps,
  current,
  tone = "accent",
  compact = false,
}: {
  steps: readonly string[];
  current: number;
  tone?: PathTone;
  /** One line, "Step N of M · name", over thin ticks; the step names stay for assistive tech. */
  compact?: boolean;
}) {
  if (compact) return <CompactPath steps={steps} current={current} tone={tone} />;
  return (
    <ol
      className="m-0 grid list-none gap-1 p-0"
      style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
      aria-label="Delivery Path"
    >
      {steps.map((name, index) => (
        <li
          key={name}
          aria-current={index === current ? "step" : undefined}
          className={cn(
            "grid gap-1.5 text-2xs text-muted before:h-1 before:rounded-full before:bg-rule before:content-['']",
            index < current && "before:bg-[color-mix(in_srgb,var(--accent)_55%,var(--border))]",
            index === current && "font-semibold text-text",
            index === current && BAR[tone],
          )}
        >
          {name}
        </li>
      ))}
    </ol>
  );
}
