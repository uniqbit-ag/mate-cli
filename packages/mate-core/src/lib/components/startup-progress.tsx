/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { Box, Static, Text, render as inkRender, renderToString } from "ink";

import { BRAND_ACCENT } from "../../brand/palette";
import { installLiveProgress } from "../live-progress";
import { useSpinnerFrame } from "./spinner";

export type StartupStepStatus = "running" | "done" | "error";

export interface StartupStep {
  id: string;
  label: string;
  status: StartupStepStatus;
}

/**
 * A line printed once: a finished step, the start line of a step that hands
 * the terminal over, or a warning. `key` stays unique when a step id runs again.
 */
export interface StartupLogEntry {
  key: string;
  kind: "done" | "error" | "handover" | "warning";
  label: string;
}

function LogRow({ entry }: { entry: StartupLogEntry }) {
  switch (entry.kind) {
    case "done":
      return (
        <Text wrap="truncate-end">
          {"  "}
          <Text color={BRAND_ACCENT}>✓</Text> {entry.label}
        </Text>
      );
    case "error":
      return (
        <Text wrap="truncate-end">
          {"  "}
          <Text color="red">✗</Text> {entry.label}
          <Text color="red"> failed</Text>
        </Text>
      );
    case "handover":
      return (
        <Text wrap="truncate-end">
          {"  "}
          {entry.label}
        </Text>
      );
    case "warning":
      return (
        <Text color="yellow">
          {"  "}
          <Text bold>warning</Text> {entry.label}
        </Text>
      );
  }
}

/** The same line without colour or cursor control, for output that is not a terminal. */
function formatPlainLogEntry(entry: StartupLogEntry): string {
  switch (entry.kind) {
    case "done":
      return `  ✓ ${entry.label}`;
    case "error":
      return `  ✗ ${entry.label} failed`;
    case "handover":
      return `  ${entry.label}`;
    case "warning":
      return `  warning ${entry.label}`;
  }
}

function LiveRow({ step }: { step: StartupStep }) {
  const spinner = useSpinnerFrame(true);
  return (
    <Text wrap="truncate-end">
      {"  "}
      <Text color={BRAND_ACCENT}>{spinner}</Text> {step.label}
    </Text>
  );
}

export interface StartupProgressAppProps {
  title: string;
  /** False when the screen remounts after a hand-over; the header is already printed. */
  showHeader: boolean;
  steps: StartupStep[];
  /** Append-only; Ink's Static prints each entry once. */
  log: StartupLogEntry[];
}

type HeaderItem = { key: "header"; title: string };

function StartupProgressApp({ title, showHeader, steps, log }: StartupProgressAppProps) {
  // The newest running step is the one live line.
  const running = steps.findLast((step) => step.status === "running");
  const printed: (HeaderItem | StartupLogEntry)[] = showHeader
    ? [{ key: "header", title }, ...log]
    : log;
  return (
    <Box flexDirection="column">
      <Static items={printed}>
        {(item) =>
          "kind" in item ? (
            <LogRow key={item.key} entry={item} />
          ) : (
            <Text key={item.key} wrap="truncate-end">
              <Text bold color={BRAND_ACCENT}>
                mate
              </Text>{" "}
              · {item.title}
            </Text>
          )
        }
      </Static>
      {running ? <LiveRow step={running} /> : null}
    </Box>
  );
}

export interface StartupProgressController {
  start(id: string, label: string): void;
  succeed(id: string): void;
  fail(id: string): void;
  /** Marks whichever step is currently running or handed over as failed (used for unexpected errors). */
  failCurrent(): void;
  /** Runs `fn` as a live step: `✓` when it resolves, `✗` when it throws (rethrown). */
  step<T>(id: string, label: string, fn: () => T | Promise<T>): Promise<T>;
  /**
   * Prints a start line and leaves the terminal to a child process or prompt,
   * with no spinner, until `succeed` or `fail` prints the result line.
   */
  handOver(id: string, label: string): void;
  warn(message: string): void;
  stop(): void;
}

export interface StartupProgressDeps {
  render?: typeof inkRender;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  /** Animated Ink screen when true, plain lines otherwise. Defaults to `stdout.isTTY`. */
  interactive?: boolean;
}

export function createStartupProgress(
  title: string,
  deps: StartupProgressDeps = {},
): StartupProgressController {
  const render = deps.render ?? inkRender;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const interactive = deps.interactive ?? stdout.isTTY === true;
  let steps: StartupStep[] = [];
  /** Steps whose start line is printed and whose child owns the terminal. */
  const handedOver = new Map<string, string>();
  /** Entries printed by the current Ink mount. */
  let log: StartupLogEntry[] = [];
  let showHeader = true;
  let entryCount = 0;
  let instance: ReturnType<typeof inkRender> | undefined;
  let stopped = false;

  const app = () => (
    <StartupProgressApp title={title} showHeader={showHeader} steps={steps} log={log} />
  );

  const mount = (withHeader: boolean) => {
    showHeader = withHeader;
    log = [];
    instance = render(app(), { stdout, stderr });
  };

  const rerender = () => {
    instance?.rerender(app());
  };

  const unmount = () => {
    instance?.unmount();
    instance = undefined;
  };

  const print = (kind: StartupLogEntry["kind"], label: string) => {
    const entry: StartupLogEntry = { key: `${kind}:${entryCount++}`, kind, label };
    if (!interactive) {
      stdout.write(`${formatPlainLogEntry(entry)}\n`);
    } else if (instance) {
      log = [...log, entry];
      rerender();
    } else {
      // Unmounted after a hand-over: write the line directly instead of remounting.
      stdout.write(
        `${renderToString(<LogRow entry={entry} />, { columns: stdout.columns || 80 })}\n`,
      );
    }
  };

  /** Running live steps lose their spinner and finish later as handed-over steps. */
  const handOverRunning = () => {
    const running = steps.filter((step) => step.status === "running");
    if (running.length === 0) return;
    steps = steps.filter((step) => step.status !== "running");
    for (const step of running) {
      handedOver.set(step.id, step.label);
      print("handover", step.label);
    }
  };

  const finish = (id: string, status: "done" | "error") => {
    if (stopped) return;
    const step = steps.find((candidate) => candidate.id === id);
    if (step) {
      steps = steps.map((candidate) =>
        candidate.id === id ? { ...candidate, status } : candidate,
      );
      print(status, step.label);
      return;
    }
    const label = handedOver.get(id);
    if (label === undefined) return;
    handedOver.delete(id);
    print(status, label);
  };

  const controller: StartupProgressController = {
    start(id, label) {
      if (stopped) return;
      handedOver.delete(id);
      const existing = steps.some((step) => step.id === id);
      steps = existing
        ? steps.map((step) => (step.id === id ? { id, label, status: "running" } : step))
        : [...steps, { id, label, status: "running" }];
      if (interactive && !instance) mount(false);
      else rerender();
    },
    succeed(id) {
      finish(id, "done");
    },
    fail(id) {
      finish(id, "error");
    },
    failCurrent() {
      const running = steps.findLast((step) => step.status === "running");
      if (running) {
        finish(running.id, "error");
        return;
      }
      const lastHandedOver = [...handedOver.keys()].at(-1);
      if (lastHandedOver !== undefined) finish(lastHandedOver, "error");
    },
    async step(id, label, fn) {
      controller.start(id, label);
      try {
        const result = await fn();
        finish(id, "done");
        return result;
      } catch (error) {
        finish(id, "error");
        throw error;
      }
    },
    handOver(id, label) {
      if (stopped) return;
      steps = steps.filter((step) => step.id !== id);
      handOverRunning();
      handedOver.set(id, label);
      print("handover", label);
      unmount();
    },
    warn(message) {
      if (stopped) return;
      // Outside a terminal there is no live line to protect; warnings stay on stderr.
      if (!interactive) stderr.write(`${message}\n`);
      else print("warning", message);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      unmount();
      restoreLiveProgress();
    },
  };

  const restoreLiveProgress = interactive
    ? installLiveProgress({
        warn: (message) => controller.warn(message),
        releaseTerminal: () => {
          if (stopped) return;
          handOverRunning();
          unmount();
        },
      })
    : () => {};

  if (interactive) mount(true);
  else stdout.write(`mate · ${title}\n`);

  return controller;
}
