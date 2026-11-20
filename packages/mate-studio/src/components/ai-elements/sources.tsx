/*
 * Adapted from AI Elements (https://github.com/vercel/ai-elements), Copyright Vercel, Inc.,
 * Apache License 2.0. Changed for Studio: Sources and Inline Citation in one module; the
 * sources are companion files the answer read, opened in the Vault rather than on the web;
 * Base UI's Collapsible instead of Radix; a citation is a file chip, not a hover card.
 */
import { Collapsible } from "@base-ui/react/collapsible";
import { type ReactNode, createContext, useContext } from "react";

import { cn } from "../../lib/cn";
import { Icon } from "../icon";

/** The files one answer read, folded into one line until opened. */
export function Sources({
  count,
  className,
  children,
}: {
  count: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible.Root className={cn("min-w-0", className)} data-chat-sources>
      <Collapsible.Trigger className="group/sources inline-flex items-center gap-1.5 rounded-control px-1.5 py-1 text-xs text-muted transition-colors hover:bg-surface hover:text-text">
        <Icon name="doc" className="size-3.5" />
        Read {count} {count === 1 ? "file" : "files"}
        <Icon
          name="chevron"
          className="size-3.5 transition-transform group-data-[panel-open]/sources:rotate-180"
        />
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <ul className="m-0 mt-1 grid list-none gap-0.5 p-0 pl-1.5">{children}</ul>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** One source's row: give it the link that opens the file. */
export function Source({ children }: { children: ReactNode }) {
  return <li className="min-w-0">{children}</li>;
}

/** Classes for a source's link, so the caller's router link looks like the rest. */
export const SOURCE_LINK =
  "inline-flex max-w-full items-center gap-1.5 rounded-control px-1.5 py-0.5 font-mono text-2xs text-muted no-underline hover:bg-surface hover:text-accent";

/** Classes for a citation chip: a file named in the answer that the answer read. */
export const CITATION_LINK =
  "inline-flex max-w-full items-baseline gap-1 rounded-[4px] border border-rule bg-surface px-1 font-mono text-[0.86em] text-text no-underline hover:border-accent hover:text-accent";

/** Turns an inline code span into a citation when it names a file the answer read; `null` keeps the code. */
type Cite = (text: string) => ReactNode | null;

const CitationContext = createContext<Cite | null>(null);

/** Makes inline code inside it cite the files `cite` knows. */
export function CitationProvider({ cite, children }: { cite: Cite; children: ReactNode }) {
  return <CitationContext value={cite}>{children}</CitationContext>;
}

/** Inline code, or the citation its text names. */
export function InlineCitation({ children }: { children: ReactNode }) {
  const cite = useContext(CitationContext);
  const cited = cite && typeof children === "string" ? cite(children) : null;
  return cited ?? <code>{children}</code>;
}
