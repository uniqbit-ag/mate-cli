import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";

import { cn } from "../lib/cn";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

/** A view's title and one plain line on what it shows; no eyebrow. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header flex flex-wrap items-end gap-x-4 gap-y-2 px-6 pt-5 pb-1 max-sm:px-4">
      <div className="min-w-0">
        <h1 className="m-0 text-xl font-semibold tracking-[-0.015em]">{title}</h1>
        <p className="m-0 mt-0.5 text-sm text-muted">{description}</p>
      </div>
      {actions ? <div className="ml-auto flex items-center gap-1.5">{actions}</div> : null}
    </header>
  );
}

/** The page's padding for content under the header. */
export const PAGE_PAD = "px-6 max-sm:px-4";

export type Tone = "warn" | "bad" | "accent" | "why" | "muted";

const TONE_TEXT: Record<Tone, string> = {
  warn: "text-warn",
  bad: "text-bad",
  accent: "text-accent",
  why: "text-why",
  muted: "text-muted",
};

/** A count beside its label: a small tabular chip, amber only when the items need the person. */
export function Count({
  value,
  tone,
  className,
  label,
}: {
  value: number;
  tone?: "warn";
  className?: string;
  /** The accessible name when the bare number is not enough. */
  label?: string;
}) {
  return (
    <span
      className={cn(
        "count inline-grid h-[18px] min-w-[18px] flex-none place-items-center rounded-full px-1.5 font-mono text-2xs leading-none font-medium tabular-nums",
        tone === "warn" && value > 0
          ? "bg-warn-soft text-warn"
          : "bg-[color-mix(in_srgb,var(--muted)_16%,transparent)] text-muted",
        className,
      )}
      aria-label={label}
    >
      {value}
    </span>
  );
}

/**
 * A group of items: the title bar carries the name, count and an optional hint on the surface
 * tint; the rows sit on the page. Never nested, never around a graph, document or form.
 */
export function ListCard({
  title,
  count,
  hint,
  tone,
  children,
  className,
  label,
}: {
  title: ReactNode;
  count?: number;
  hint?: ReactNode;
  tone?: Tone;
  children: ReactNode;
  className?: string;
  /** The accessible name when the title is not plain text. */
  label?: string;
}) {
  return (
    <section
      className={cn("list-card overflow-hidden rounded-card border border-rule", className)}
      aria-label={label ?? (typeof title === "string" ? title : undefined)}
    >
      <div
        className={cn(
          "list-card-head flex items-center gap-2.5 border-b border-rule bg-surface px-4 py-2 text-[0.9rem] font-semibold",
          tone ? TONE_TEXT[tone] : null,
        )}
      >
        <h2 className="m-0 text-[inherit] font-[inherit]">{title}</h2>
        {count !== undefined ? (
          <Count value={count} tone={tone === "warn" ? "warn" : undefined} />
        ) : null}
        {hint ? <span className="ml-auto text-xs font-normal text-muted">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** A row in a list card: one line, soft rule above, the surface tint on hover and when current. */
export const ROW =
  "list-row flex w-full min-w-0 items-center gap-4 border-0 border-t border-rule-soft bg-transparent px-4 py-2 text-left text-base text-text no-underline transition-colors first:border-t-0 hover:bg-surface aria-[current=true]:bg-surface aria-[current=true]:shadow-[inset_2px_0_0_var(--accent)]";

export interface PillOption<T extends string> {
  value: T;
  label: string;
  count?: number;
  tone?: Tone;
}

/** Narrows a list in place; one value is always chosen. */
export function Pills<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: PillOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(next) => {
        const chosen = next[0] as T | undefined;
        if (chosen) onChange(chosen);
      }}
      className={className}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value}>
          {option.label}
          {option.count !== undefined ? (
            <Count value={option.count} tone={option.tone === "warn" ? "warn" : undefined} />
          ) : null}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

const MARKERS: Record<string, string> = {
  /** Diamond: waiting on a person. */
  review: "rotate-45 rounded-[2px] size-[7px] bg-why",
  /** Diamond: under way. */
  build: "rotate-45 rounded-[2px] size-[7px] bg-accent",
  /** Circle: done. */
  done: "rounded-full size-2 bg-accent",
  /** Square: something is wrong. */
  issue: "rounded-[1px] size-2 bg-bad",
  /** Ring: nothing happening. */
  idle: "rounded-full size-2 ring-[1.5px] ring-muted ring-inset",
  warn: "rounded-full size-2 bg-warn",
};

const MARKER_TEXT: Record<string, string> = {
  review: "text-why",
  build: "text-accent",
  done: "text-accent",
  issue: "text-bad",
  idle: "text-muted",
  warn: "text-warn",
};

export type Marker = keyof typeof MARKERS;

/** A status word with its marker shape, so the state never rests on colour alone. */
export function StatusWord({ marker, children }: { marker: Marker; children: ReactNode }) {
  return (
    <span
      className={cn(
        "status-word inline-flex items-center gap-2 text-xs whitespace-nowrap",
        MARKER_TEXT[marker],
      )}
    >
      <span className={cn("flex-none", MARKERS[marker])} aria-hidden="true" />
      {children}
    </span>
  );
}

/** "N of M tasks" with its bar. */
export function Progress({ done, total }: { done: number; total: number }) {
  if (total === 0) return <span className="text-xs text-muted">No tasks</span>;
  const percent = Math.min(100, Math.round((done / total) * 100));
  const label = `${done} of ${total} tasks`;
  return (
    <span className="grid min-w-[120px] gap-1.5 text-xs text-muted">
      <span>{label}</span>
      <span
        className="relative block h-1 w-full max-w-[140px] overflow-hidden rounded-full bg-rule"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={label}
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-accent"
          style={{ width: `${percent}%` }}
        />
      </span>
    </span>
  );
}

const subscribe = () => () => {};

/** "22m ago" from the viewer's clock; filled in after hydration so server and browser agree. */
export function Age({ at, className }: { at: string | number | undefined; className?: string }) {
  const text = useSyncExternalStore(
    subscribe,
    () => (at === undefined ? "" : ageText(at, Date.now())),
    () => "",
  );
  if (at === undefined) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <time
      dateTime={date.toISOString()}
      className={cn("font-mono text-xs whitespace-nowrap text-muted", className)}
    >
      {text}
    </time>
  );
}

function ageText(at: string | number, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(at).getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** A plain sentence for a list with nothing in it; no empty card. */
export function EmptyNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "empty m-0 rounded-card border border-dashed border-rule px-5 py-5 text-base text-muted",
        className,
      )}
    >
      {children}
    </p>
  );
}

/** A command as the person would type it; `copy` is the text copied when it differs. */
export function CommandLine({
  text,
  copy = text,
  label = "prompt",
}: {
  text: string;
  copy?: string;
  label?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-control border border-rule bg-page py-1.5 pr-1.5 pl-3 font-mono text-xs">
      <code className="min-w-0 flex-1 truncate">{text}</code>
      <button
        type="button"
        className="inline-flex h-7 flex-none items-center rounded-[6px] border border-rule bg-surface px-2.5 font-sans text-xs text-text hover:border-accent hover:bg-accent-soft"
        data-copy={copy}
        data-copy-label={label}
      >
        Copy
      </button>
    </div>
  );
}
