/*
 * Adapted from AI Elements (https://github.com/vercel/ai-elements), Copyright Vercel, Inc.,
 * Apache License 2.0. Changed for Studio: only Message, MessageContent and MessageResponse;
 * Studio's colour tokens and markdown styles; Streamdown without images, raw HTML, controls or
 * clickable links; inline code that names a file the answer read becomes its citation.
 */
import type { UIMessage } from "ai";
import { type ComponentProps, type HTMLAttributes, memo } from "react";
import { Streamdown } from "streamdown";

import { cn } from "../../lib/cn";
import { InlineCitation } from "./sources";

export function Message({
  className,
  from,
  ...props
}: HTMLAttributes<HTMLDivElement> & { from: UIMessage["role"] }) {
  return (
    <div
      data-from={from}
      className={cn(
        "group flex w-full flex-col gap-2",
        from === "user" ? "items-end" : "items-start",
        className,
      )}
      {...props}
    />
  );
}

export function MessageContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex min-w-0 max-w-full flex-col gap-2 text-base text-text",
        "group-data-[from=user]:max-w-[85%] group-data-[from=user]:rounded-card group-data-[from=user]:border group-data-[from=user]:border-rule group-data-[from=user]:bg-surface group-data-[from=user]:px-3.5 group-data-[from=user]:py-2.5",
        "group-data-[from=assistant]:w-full",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Model text as markdown while it streams. Images are dropped, raw HTML skipped and links shown
 * as text: the page loads nothing from another host, and an answer cannot make it.
 */
const STREAMDOWN_COMPONENTS: ComponentProps<typeof Streamdown>["components"] = {
  img: ({ alt }) => (alt ? <span className="text-muted">[{alt}]</span> : null),
  // Plain elements, so Studio's `.markdown-body` styles apply: Streamdown's own classes assume
  // shadcn's tokens, where `bg-muted` is a fill, not Studio's muted text colour.
  strong: ({ children }) => <strong>{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  h5: "h5",
  h6: "h6",
  p: "p",
  ul: "ul",
  ol: "ol",
  li: "li",
  blockquote: "blockquote",
  hr: "hr",
  inlineCode: ({ children }) => <InlineCitation>{children}</InlineCitation>,
  code: ({ children, className }) => <code className={className}>{children}</code>,
  pre: ({ children }) => <pre>{children}</pre>,
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
  thead: "thead",
  tbody: "tbody",
  tr: "tr",
  th: "th",
  td: "td",
  // Not clickable: a link a file planted could carry what the agent read off this machine.
  // Its address shows as text, for the reader to judge and copy.
  a: ({ href, children }) => (
    <span data-chat-link>
      {children}
      {href && href !== String(children) ? (
        <span className="text-muted">
          {" ("}
          <code>{href}</code>
          {")"}
        </span>
      ) : null}
    </span>
  ),
};

export const MessageResponse = memo(
  ({ className, ...props }: ComponentProps<typeof Streamdown>) => (
    <Streamdown
      className={cn("markdown-body chat-answer", className)}
      components={STREAMDOWN_COMPONENTS}
      controls={false}
      linkSafety={{ enabled: false }}
      skipHtml
      {...props}
    />
  ),
  (previous, next) =>
    previous.children === next.children && previous.isAnimating === next.isAnimating,
);
MessageResponse.displayName = "MessageResponse";
