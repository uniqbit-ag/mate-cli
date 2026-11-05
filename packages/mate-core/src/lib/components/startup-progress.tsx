/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { Box, Static, Text, render as inkRender } from "ink";

import { BRAND_ACCENT } from "../../brand/palette";
import { useSpinnerFrame } from "./spinner";

export type StartupStepStatus = "running" | "done" | "error";

export interface StartupStep {
  id: string;
  label: string;
  status: StartupStepStatus;
}

/** A finished step as printed once; `key` stays unique when a step id runs again. */
export interface StartupLogEntry extends StartupStep {
  key: string;
}

function FinishedRow({ step }: { step: StartupStep }) {
  const failed = step.status === "error";
  return (
    <Text wrap="truncate-end">
      {"  "}
      {failed ? <Text color="red">✗</Text> : <Text color={BRAND_ACCENT}>✓</Text>} {step.label}
      {failed ? <Text color="red"> failed</Text> : null}
    </Text>
  );
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
  steps: StartupStep[];
  /** Append-only; Ink's Static prints each entry once. */
  log: StartupLogEntry[];
}

type HeaderItem = { key: "header"; title: string };

function StartupProgressApp({ title, steps, log }: StartupProgressAppProps) {
  // The newest running step is the one live line.
  const running = steps.findLast((step) => step.status === "running");
  const printed: (HeaderItem | StartupLogEntry)[] = [{ key: "header", title }, ...log];
  return (
    <Box flexDirection="column">
      <Static items={printed}>
        {(item) =>
          "status" in item ? (
            <FinishedRow key={item.key} step={item} />
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
  /** Marks whichever step is currently running as failed (used for unexpected errors). */
  failCurrent(): void;
  stop(): void;
}

export interface StartupProgressDeps {
  render?: typeof inkRender;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

export function createStartupProgress(
  title: string,
  deps: StartupProgressDeps = {},
): StartupProgressController {
  const render = deps.render ?? inkRender;
  let steps: StartupStep[] = [];
  let log: StartupLogEntry[] = [];
  let stopped = false;

  const rendered = render(<StartupProgressApp title={title} steps={steps} log={log} />, {
    stdout: deps.stdout ?? process.stdout,
    stderr: deps.stderr ?? process.stderr,
  });

  const rerender = () => {
    if (stopped) return;
    rendered.rerender(<StartupProgressApp title={title} steps={steps} log={log} />);
  };

  const finish = (id: string, status: "done" | "error") => {
    const step = steps.find((candidate) => candidate.id === id);
    if (!step) return;
    steps = steps.map((candidate) => (candidate.id === id ? { ...candidate, status } : candidate));
    log = [...log, { ...step, status, key: `${id}:${log.length}` }];
    rerender();
  };

  return {
    start(id, label) {
      const existing = steps.some((step) => step.id === id);
      steps = existing
        ? steps.map((step) => (step.id === id ? { id, label, status: "running" } : step))
        : [...steps, { id, label, status: "running" }];
      rerender();
    },
    succeed(id) {
      finish(id, "done");
    },
    fail(id) {
      finish(id, "error");
    },
    failCurrent() {
      const running = steps.find((step) => step.status === "running");
      if (!running) return;
      finish(running.id, "error");
    },
    stop() {
      if (stopped) return;
      stopped = true;
      rendered.unmount();
    },
  };
}
