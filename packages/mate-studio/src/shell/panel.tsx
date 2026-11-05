import { type ReactNode, useEffect, useEffectEvent, useRef } from "react";

import { Icon } from "../components/icon";
import { inField } from "../lib/in-field";
import { Button } from "../components/ui/button";
import { Kbd } from "../components/ui/fields";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "../components/ui/sheet";

interface SidePanelProps {
  /** The ids Previous and Next walk, in list order; a pass narrows them to a subset. */
  items: readonly string[];
  /** The open item, or `null` when the panel is closed. */
  current: string | null;
  onSelect: (id: string | null) => void;
  /** Named while the panel walks a subset, e.g. "Needs you". */
  pass?: string;
  wide?: boolean;
  /** The accessible name of the open item. */
  title: string;
  children: ReactNode;
}

/**
 * The one slide-over panel (design D3): an item's detail floats over the page from the right,
 * walks its list with Previous, Next and the arrow keys, and returns focus to its opener.
 */
export function SidePanel({
  items,
  current,
  onSelect,
  pass,
  wide,
  title,
  children,
}: SidePanelProps) {
  const opener = useRef<HTMLElement | null>(null);
  const open = current !== null;
  const index = current === null ? -1 : items.indexOf(current);
  const previous = index > 0 ? items[index - 1] : undefined;
  const next = index >= 0 && index < items.length - 1 ? items[index + 1] : undefined;

  // The last element focused outside the panel is where focus returns on close.
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest && !target.closest("[data-slot=sheet-content]")) opener.current = target;
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, []);

  const walk = useEffectEvent((event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || inField(event.target)) return;
    const to = event.key === "ArrowRight" ? next : event.key === "ArrowLeft" ? previous : undefined;
    if (to === undefined) return;
    event.preventDefault();
    onSelect(to);
  });
  useEffect(() => {
    if (!open) return;
    const listener = (event: KeyboardEvent) => walk(event);
    // Capture: the open dialog stops keys from bubbling past it.
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, [open]);

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onSelect(null);
      }}
    >
      <SheetContent
        wide={wide}
        aria-label={title}
        finalFocus={() => (opener.current?.isConnected ? opener.current : true)}
        initialFocus={() => document.getElementById("side-panel-close")}
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        <div className="flex items-center gap-1.5 border-b border-rule py-2.5 pr-3 pl-5">
          <span className="mr-auto font-mono text-xs text-muted" aria-live="polite">
            {index >= 0 ? `${index + 1} of ${items.length}` : null}
            {pass ? ` · ${pass}` : null}
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Previous"
            disabled={previous === undefined}
            onClick={() => previous !== undefined && onSelect(previous)}
          >
            <Icon name="left" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Next"
            disabled={next === undefined}
            onClick={() => next !== undefined && onSelect(next)}
          >
            <Icon name="right" />
          </Button>
          <SheetClose
            id="side-panel-close"
            render={<Button size="icon-sm" variant="ghost" aria-label="Close" />}
          >
            <Icon name="close" />
          </SheetClose>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
        <div className="flex gap-3.5 border-t border-rule px-5 py-2.5 text-2xs text-muted max-sm:hidden">
          <span className="inline-flex items-center gap-1.5">
            <Kbd>←</Kbd>
            <Kbd>→</Kbd> previous, next
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>esc</Kbd> close
          </span>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The panel's lead: what the item is, then its name. */
export function PanelHead({
  kicker,
  title,
  mono = false,
  children,
}: {
  kicker?: ReactNode;
  title: ReactNode;
  mono?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="grid gap-1.5 border-b border-rule px-5 pt-4 pb-3.5">
      {kicker ? <div className="flex items-center gap-2 text-xs text-muted">{kicker}</div> : null}
      <h2
        className={
          mono ? "m-0 font-mono text-md font-semibold break-words" : "m-0 text-lg font-semibold"
        }
      >
        {title}
      </h2>
      {children}
    </div>
  );
}

/** One section of the panel, under a short heading. */
export function PanelSection({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-2.5 border-b border-rule-soft px-5 py-4" aria-label={title}>
      <h3 className="m-0 flex items-center gap-2 text-sm font-semibold">
        {title}
        {aside ? (
          <span className="ml-auto font-mono text-2xs font-normal text-muted">{aside}</span>
        ) : null}
      </h3>
      {children}
    </section>
  );
}
