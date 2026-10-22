import { useEffect, useState, useSyncExternalStore } from "react";
import type { TerminalLine } from "@/content/landing";

const TYPE_MS = 45;
const COMMAND_PAUSE_MS = 450;
const OUTPUT_PAUSE_MS = 250;

interface Progress {
  /** Lines fully shown. */
  line: number;
  /** Characters typed of the current command line. */
  chars: number;
}

function nextDelay(lines: TerminalLine[], { line, chars }: Progress): number | null {
  const current = lines[line];
  if (!current) return null;
  if (current.kind === "output") return OUTPUT_PAUSE_MS;
  return chars === 0 ? COMMAND_PAUSE_MS : TYPE_MS;
}

function advance(lines: TerminalLine[], { line, chars }: Progress): Progress {
  const current = lines[line];
  if (current?.kind === "command" && chars < current.text.length) {
    return { line, chars: chars + 1 };
  }
  return { line: line + 1, chars: 0 };
}

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const media = window.matchMedia(reducedMotionQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function Prompt() {
  return <span className="text-fd-primary select-none">$ </span>;
}

function Caret({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block h-4 w-2 translate-y-0.5 animate-pulse bg-fd-foreground/70 ${className}`}
    />
  );
}

/**
 * Plays the install → link → launch sequence once. The server render and
 * `prefers-reduced-motion` both show the finished transcript.
 */
export function TerminalDemo({ lines }: { lines: TerminalLine[] }) {
  const reduceMotion = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(reducedMotionQuery).matches,
    () => true,
  );
  const [typed, setTyped] = useState<Progress>({ line: 0, chars: 0 });
  const progress = reduceMotion ? { line: lines.length, chars: 0 } : typed;

  useEffect(() => {
    if (reduceMotion) return;
    const delay = nextDelay(lines, typed);
    if (delay === null) return;
    const timer = setTimeout(() => setTyped((p) => advance(lines, p)), delay);
    return () => clearTimeout(timer);
  }, [lines, typed, reduceMotion]);

  const done = progress.line >= lines.length;

  return (
    <div className="w-full overflow-hidden rounded-xl border bg-fd-card text-left shadow-lg">
      <div className="flex items-center gap-1.5 border-b px-4 py-2.5" aria-hidden="true">
        <span className="size-2.5 rounded-full bg-fd-muted-foreground/30" />
        <span className="size-2.5 rounded-full bg-fd-muted-foreground/30" />
        <span className="size-2.5 rounded-full bg-fd-muted-foreground/30" />
        <span className="ml-2 font-mono text-xs text-fd-muted-foreground">~/code/web-app</span>
      </div>
      <pre
        className="min-h-64 p-4 font-mono text-[13px] leading-6"
        aria-label="Terminal: mate install, mate companion link, mate claude"
      >
        {lines.map((line, index) => {
          if (index > progress.line) return null;
          const partial = index === progress.line;
          if (line.kind === "output") {
            if (partial) return null;
            return (
              <div key={`output:${line.text}`} className="text-fd-muted-foreground">
                {line.text}
              </div>
            );
          }
          const text = partial ? line.text.slice(0, progress.chars) : line.text;
          return (
            <div key={`command:${line.text}`}>
              <Prompt />
              {text}
              {partial ? <Caret className="ml-px" /> : null}
            </div>
          );
        })}
        {done ? (
          <div>
            <Prompt />
            <Caret />
          </div>
        ) : null}
      </pre>
    </div>
  );
}
