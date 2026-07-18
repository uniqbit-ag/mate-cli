import { Box, Text, render as inkRender } from "ink";
import React from "react";

import { useSpinnerFrame } from "./spinner";
import { MIDNIGHT_PURPLE_BRIGHT } from "./theme";

export type StartupStepStatus = "running" | "done" | "error";

export interface StartupStep {
  id: string;
  label: string;
  status: StartupStepStatus;
}

function StepRow({ step }: { step: StartupStep }) {
  const spinner = useSpinnerFrame(step.status === "running");

  const icon =
    step.status === "done" ? (
      <Text color="green">✓</Text>
    ) : step.status === "error" ? (
      <Text color="red">✗</Text>
    ) : (
      <Text color={MIDNIGHT_PURPLE_BRIGHT}>{spinner}</Text>
    );

  return (
    <Text>
      {icon}{" "}
      <Text color={step.status === "running" ? MIDNIGHT_PURPLE_BRIGHT : undefined}>
        {step.label}
      </Text>
    </Text>
  );
}

export interface StartupProgressAppProps {
  title: string;
  steps: StartupStep[];
}

export function StartupProgressApp({ title, steps }: StartupProgressAppProps) {
  return (
    <Box flexDirection="column">
      <Text bold color={MIDNIGHT_PURPLE_BRIGHT}>
        {title}
      </Text>
      {steps.map((step) => (
        <StepRow key={step.id} step={step} />
      ))}
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
  let stopped = false;

  const rendered = render(<StartupProgressApp title={title} steps={steps} />, {
    stdout: deps.stdout ?? process.stdout,
    stderr: deps.stderr ?? process.stderr,
  });

  const rerender = () => {
    if (stopped) return;
    rendered.rerender(<StartupProgressApp title={title} steps={steps} />);
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
      steps = steps.map((step) => (step.id === id ? { ...step, status: "done" } : step));
      rerender();
    },
    fail(id) {
      steps = steps.map((step) => (step.id === id ? { ...step, status: "error" } : step));
      rerender();
    },
    failCurrent() {
      const running = steps.find((step) => step.status === "running");
      if (!running) return;
      steps = steps.map((step) => (step.id === running.id ? { ...step, status: "error" } : step));
      rerender();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      rendered.unmount();
    },
  };
}
