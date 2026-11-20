/*
 * Adapted from AI Elements (https://github.com/vercel/ai-elements), Copyright Vercel, Inc.,
 * Apache License 2.0. Changed for Studio: Base UI's Collapsible instead of Radix, a one-line
 * header naming the tool and its target, steps grouped as one list, Studio's icons, spinner
 * and status tokens, and plain preformatted input and output instead of the code block.
 */
import { Collapsible } from "@base-ui/react/collapsible";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/cn";
import { Icon } from "../icon";
import { Spinner } from "../ui/spinner";
import { stepFailed, type ToolPart } from "./tool-state";

const STEPS_FRAME = "w-full overflow-hidden rounded-control border border-rule-soft bg-page";
const STEP_ROW =
  "flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted hover:bg-surface hover:text-text";

function EndMark({ failed }: { failed: boolean }) {
  return (
    <Icon
      name={failed ? "close" : "check"}
      className={cn("size-3.5", failed ? "text-bad" : "text-done")}
    />
  );
}

/**
 * Consecutive steps of one answer, one row each with a soft rule between. With a `summary`,
 * they fold into that one line until the reader opens it.
 */
export function ToolSteps({
  className,
  children,
  summary,
  failed = false,
}: {
  className?: string;
  children: ReactNode;
  summary?: string;
  failed?: boolean;
}) {
  if (!summary) {
    return (
      <div className={cn(STEPS_FRAME, "divide-y divide-rule-soft", className)}>{children}</div>
    );
  }
  return (
    <Collapsible.Root className={cn(STEPS_FRAME, className)} data-chat-steps>
      <Collapsible.Trigger className={cn(STEP_ROW, "group/steps")}>
        <EndMark failed={failed} />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        <Icon
          name="chevron"
          className="size-3.5 transition-transform group-data-[panel-open]/steps:rotate-180"
        />
      </Collapsible.Trigger>
      <Collapsible.Panel className="divide-y divide-rule-soft border-t border-rule-soft">
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/**
 * Consecutive steps of one tool as one row: what they did and what they worked on, folded
 * until the reader opens it. Running while any step runs; failed when any failed.
 */
export function ToolBatch({
  name,
  label,
  targets,
  running,
  failed,
  children,
}: {
  name: string;
  label: string;
  targets: string[];
  running: boolean;
  failed: number;
  children: ReactNode;
}) {
  return (
    <Collapsible.Root className="w-full" data-chat-batch={name}>
      <Collapsible.Trigger className={cn(STEP_ROW, "group/batch")}>
        {running ? (
          <Spinner aria-hidden="true" role={undefined} className="size-3.5 text-accent" />
        ) : (
          <EndMark failed={failed > 0} />
        )}
        <span className="font-semibold text-text">{label}</span>
        <span className="min-w-0 flex-1 truncate font-mono">{targets.join(", ")}</span>
        {failed > 0 ? <span className="text-bad">{failed} failed</span> : null}
        <Icon
          name="chevron"
          className="size-3.5 transition-transform group-data-[panel-open]/batch:rotate-180"
        />
      </Collapsible.Trigger>
      <Collapsible.Panel className="divide-y divide-rule-soft border-t border-rule-soft pl-4">
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

export function Tool({ className, ...props }: Collapsible.Root.Props) {
  return <Collapsible.Root className={cn("w-full", className)} {...props} />;
}

const STATE_LABEL: Record<ToolPart["state"], string> = {
  "input-streaming": "starting",
  "input-available": "running",
  "approval-requested": "waiting",
  "approval-responded": "answered",
  "output-available": "done",
  "output-error": "failed",
  "output-denied": "denied",
};

/** One line: the tool, what it worked on, and how it ended. */
export function ToolHeader({
  name,
  target,
  state,
  stopped = false,
  className,
}: {
  name: string;
  target: string;
  state: ToolPart["state"];
  /** The answer ended (stopped or failed) while this step had no result yet. */
  stopped?: boolean;
  className?: string;
}) {
  const failed = stepFailed(state);
  const unfinished = state === "input-streaming" || state === "input-available";
  let marker: ReactNode = <EndMark failed={failed} />;
  if (unfinished) {
    marker = stopped ? (
      <Icon name="close" className="size-3.5 text-muted" />
    ) : (
      <Spinner aria-hidden="true" role={undefined} className="size-3.5 text-accent" />
    );
  }
  return (
    <Collapsible.Trigger className={cn(STEP_ROW, "group/tool", className)}>
      {marker}
      <span className="font-semibold text-text">{name}</span>
      <span className="min-w-0 flex-1 truncate font-mono">{target}</span>
      {/* Done is the quiet default; any other state is named beside its marker. */}
      <span className={cn(state === "output-available" ? "sr-only" : failed && "text-bad")}>
        {unfinished && stopped ? "stopped" : STATE_LABEL[state]}
      </span>
      <Icon
        name="chevron"
        className="size-3.5 transition-transform group-data-[panel-open]/tool:rotate-180"
      />
    </Collapsible.Trigger>
  );
}

export function ToolContent({ className, ...props }: Collapsible.Panel.Props) {
  return (
    <Collapsible.Panel
      className={cn("grid gap-2 border-t border-rule-soft bg-surface px-2.5 py-2", className)}
      {...props}
    />
  );
}

const SHOWN_CHARS = 4_000;

function shown(value: unknown): string {
  // `JSON.stringify(undefined)` is undefined, as a tool's input is while it streams.
  const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
  return text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS)}\n…` : text;
}

export function ToolInput({
  input,
  className,
  ...props
}: ComponentProps<"div"> & { input: unknown }) {
  return (
    <div className={cn("grid gap-1", className)} {...props}>
      <span className="text-2xs font-semibold tracking-wider text-muted uppercase">Input</span>
      <pre className="max-h-40 overflow-auto rounded-control bg-page p-2 font-mono text-2xs text-text">
        {shown(input)}
      </pre>
    </div>
  );
}

export function ToolOutput({
  output,
  errorText,
  className,
  ...props
}: ComponentProps<"div"> & { output: unknown; errorText: string | undefined }) {
  if (output === undefined && !errorText) return null;
  return (
    <div className={cn("grid gap-1", className)} {...props}>
      <span className="text-2xs font-semibold tracking-wider text-muted uppercase">
        {errorText ? "Error" : "Result"}
      </span>
      <pre
        className={cn(
          "max-h-56 overflow-auto rounded-control p-2 font-mono text-2xs",
          errorText ? "bg-bad-soft text-bad" : "bg-page text-text",
        )}
      >
        {errorText ?? shown(output)}
      </pre>
    </div>
  );
}
