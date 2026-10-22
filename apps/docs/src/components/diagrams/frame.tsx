import { Fragment, type ReactNode } from "react";

export function DiagramFrame({ caption, children }: { caption?: string; children: ReactNode }) {
  return (
    <figure className="@container not-prose my-6 rounded-xl border bg-fd-card p-4 text-fd-card-foreground sm:p-6">
      {children}
      {caption ? (
        <figcaption className="mt-4 text-center text-xs text-fd-muted-foreground">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

/** Frame widths, not viewport widths: the docs column is much narrower than the screen. */
type Breakpoint = "md" | "lg";

const horizontalFrom = { md: "@2xl:rotate-0", lg: "@3xl:rotate-0" };
const rowFrom = { md: "@2xl:flex-row @2xl:items-center", lg: "@3xl:flex-row @3xl:items-center" };

/** Connector that points right on wide screens and down when stacked. */
export function Arrow({ label, wideFrom = "md" }: { label?: string; wideFrom?: Breakpoint }) {
  return (
    <div
      className="flex shrink-0 flex-col items-center justify-center gap-1 text-fd-primary"
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        className={`size-5 rotate-90 ${horizontalFrom[wideFrom]}`}
        fill="none"
      >
        <path
          d="M4 12h15m-5-5 5 5-5 5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {label ? (
        <span className="text-[10px] font-medium tracking-wide text-fd-muted-foreground uppercase">
          {label}
        </span>
      ) : null}
    </div>
  );
}

/** Ordered boxes joined by arrows: a row on wide screens, a column when stacked. */
export function Flow<T extends { title: string }>({
  items,
  wideFrom = "md",
  children,
}: {
  items: T[];
  wideFrom?: Breakpoint;
  children: (item: T, index: number) => ReactNode;
}) {
  return (
    <ol className={`flex flex-col items-stretch gap-2 ${rowFrom[wideFrom]}`}>
      {items.map((item, index) => (
        <Fragment key={item.title}>
          {index > 0 ? <Arrow wideFrom={wideFrom} /> : null}
          <li className="min-w-0 flex-1 rounded-lg border bg-fd-background p-3">
            {children(item, index)}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}
