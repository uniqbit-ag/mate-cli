import { Box, Text, render as inkRender } from "ink";
import React, { useEffect } from "react";
import { SelectMenu, type SelectMenuItem } from "../lib/components/select-menu";
import { WizardFooter } from "../lib/components/wizard-footer";
import { WizardHeader } from "../lib/components/wizard-header";

export const LAUNCH_TARGETS = ["claude", "codex", "opencode"] as const;
export type LaunchTarget = (typeof LAUNCH_TARGETS)[number];

export interface LaunchPreviewData {
  repositoryId: string;
  repositoryPath: string;
  companionPath: string;
}

export interface LaunchWizardResult {
  target: LaunchTarget;
  preview: LaunchPreviewData;
}

type WizardStep = "target" | "review";
type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: LaunchPreviewData }
  | { status: "error"; message: string };

interface LaunchWizardAppProps {
  activeIndex: number;
  hasPreselectedTarget: boolean;
  items: SelectMenuItem[];
  previewState: PreviewState;
  selectedTarget: LaunchTarget | null;
  step: WizardStep;
  totalSteps: number;
  onMounted?: () => void;
}

export interface LaunchWizardOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  allowedTargets?: Set<string>;
  preselectedTarget?: LaunchTarget;
  resolvePreview(target: LaunchTarget): Promise<LaunchPreviewData>;
}

export const launchSelectorDeps = {
  render: inkRender,
};

const TARGET_ITEMS: SelectMenuItem[] = [
  { key: "claude", label: "claude" },
  { key: "codex", label: "codex" },
  { key: "opencode", label: "opencode" },
];

function parseLaunchSelectorInput(
  input: string,
): "submit" | "cancel" | "up" | "down" | "back" | null {
  if (input === "\r" || input === "\n") return "submit";
  if (input === "\x1b[A" || input === "[A") return "up";
  if (input === "\x1b[B" || input === "[B") return "down";
  if (input === "\x7f" || input === "\b") return "back";
  if (input === "\x1b" || input.toLowerCase() === "q") return "cancel";
  return null;
}

function ReviewPanel({
  previewState,
  selectedTarget,
}: {
  previewState: PreviewState;
  selectedTarget: LaunchTarget | null;
}) {
  if (previewState.status === "loading" || previewState.status === "idle") {
    return <Text dimColor>Resolving launch preview…</Text>;
  }

  if (previewState.status === "error") {
    return <Text color="red">{previewState.message}</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text>Target: {selectedTarget}</Text>
      <Text>Repository: {previewState.data.repositoryId}</Text>
      <Text dimColor>{previewState.data.repositoryPath}</Text>
      <Text>Companion:</Text>
      <Text dimColor>{previewState.data.companionPath}</Text>
    </Box>
  );
}

function LaunchWizardApp({
  activeIndex,
  hasPreselectedTarget,
  items,
  previewState,
  selectedTarget,
  step,
  totalSteps,
  onMounted,
}: LaunchWizardAppProps): React.JSX.Element {
  useEffect(() => {
    onMounted?.();
  }, [onMounted]);

  const stepNumber = hasPreselectedTarget ? 0 : step === "target" ? 0 : totalSteps - 1;
  const title = step === "target" ? "Select launch target" : "Review launch";
  const hint =
    step === "target"
      ? "↑↓ navigate · enter continue · q cancel"
      : previewState.status === "error"
        ? "enter retry · backspace previous · q cancel"
        : previewState.status === "ready"
          ? "enter launch · backspace previous · q cancel"
          : "backspace previous · q cancel";

  return (
    <Box flexDirection="column" width="100%">
      <WizardHeader title={title} step={stepNumber} totalSteps={totalSteps} />
      <Box marginTop={1} flexDirection="column">
        {step === "target" ? <SelectMenu items={items} activeIndex={activeIndex} /> : null}
        {step === "review" ? (
          <ReviewPanel previewState={previewState} selectedTarget={selectedTarget} />
        ) : null}
      </Box>
      <WizardFooter hint={hint} />
    </Box>
  );
}

export async function runLaunchWizard(
  options: LaunchWizardOptions,
): Promise<LaunchWizardResult | null> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Launch wizard requires a TTY.");
  }

  const allowedTargets = options.allowedTargets;
  const preselectedTarget = options.preselectedTarget ?? null;
  const items: SelectMenuItem[] = TARGET_ITEMS.map((item) => ({
    ...item,
    dimColor: allowedTargets ? !allowedTargets.has(item.key) : false,
  }));
  const firstEnabledIndex = items.findIndex((item) => !item.dimColor);
  let activeIndex = preselectedTarget ? 0 : firstEnabledIndex < 0 ? 0 : firstEnabledIndex;
  let step: WizardStep = preselectedTarget ? "review" : "target";
  let selectedTarget: LaunchTarget | null = preselectedTarget;
  let previewState: PreviewState = { status: "idle" };
  let previewRequestId = 0;
  let finalResult: LaunchWizardResult | null = null;
  let resolved = false;
  let rendered: ReturnType<typeof launchSelectorDeps.render> | undefined;

  const totalSteps = preselectedTarget ? 1 : 2;

  stdin.resume();
  (stdin as NodeJS.ReadStream & { ref?: () => void }).ref?.();
  const keepAlive = setInterval(() => {}, 1 << 30);

  const cleanup = () => {
    clearInterval(keepAlive);
    stdin.off("data", onData);
    stdin.pause();
    stdin.setRawMode?.(false);
    (stdin as NodeJS.ReadStream & { unref?: () => void }).unref?.();
  };

  const currentTarget = () => LAUNCH_TARGETS[activeIndex];
  const isEnabled = (index: number) => !items[index]?.dimColor;
  const nextEnabledIndex = (start: number, direction: 1 | -1): number => {
    if (!items.some((item) => !item.dimColor)) return start;
    let index = start;
    for (let i = 0; i < items.length; i += 1) {
      index = (index + direction + items.length) % items.length;
      if (isEnabled(index)) return index;
    }
    return start;
  };

  const rerender = () => {
    rendered?.rerender(
      <LaunchWizardApp
        activeIndex={activeIndex}
        hasPreselectedTarget={!!preselectedTarget}
        items={items}
        previewState={previewState}
        selectedTarget={selectedTarget}
        step={step}
        totalSteps={totalSteps}
        onMounted={onMounted}
      />,
    );
  };

  const settle = (
    value: LaunchWizardResult | null,
    resolve: (value: LaunchWizardResult | null) => void,
  ) => {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolve(value);
  };

  const loadPreview = () => {
    if (!selectedTarget) return;
    const requestId = ++previewRequestId;
    previewState = { status: "loading" };
    rerender();

    options
      .resolvePreview(selectedTarget)
      .then((preview) => {
        if (requestId !== previewRequestId || resolved) return;
        previewState = { status: "ready", data: preview };
        rerender();
      })
      .catch((error: unknown) => {
        if (requestId !== previewRequestId || resolved) return;
        previewState = {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        };
        rerender();
      });
  };

  const enterReview = () => {
    step = "review";
    loadPreview();
  };

  const onMounted = () => {
    const buffered = stdin.read();
    if (buffered) {
      // Discard buffered input before the wizard becomes interactive.
    }
    stdin.on("data", onData);
    if (step === "review") {
      loadPreview();
    }
  };

  const onData = (chunk: string) => {
    const action = parseLaunchSelectorInput(chunk);
    if (!action) return;
    if (action === "cancel") {
      finalResult = null;
      rendered?.unmount();
      return;
    }
    if (action === "back") {
      if (step === "review") {
        if (preselectedTarget) {
          finalResult = null;
          rendered?.unmount();
        } else {
          step = "target";
          previewState = { status: "idle" };
          rerender();
        }
        return;
      }
      return;
    }
    if (step === "review") {
      if (action !== "submit") return;
      if (previewState.status === "error") {
        loadPreview();
        return;
      }
      if (previewState.status !== "ready" || !selectedTarget) return;
      finalResult = {
        target: selectedTarget,
        preview: previewState.data,
      };
      rendered?.unmount();
      return;
    }
    if (action === "up" || action === "down") {
      activeIndex = nextEnabledIndex(activeIndex, action === "up" ? -1 : 1);
      rerender();
      return;
    }
    if (action !== "submit") return;
    if (!isEnabled(activeIndex)) return;
    selectedTarget = currentTarget();
    enterReview();
  };

  stdin.setEncoding("utf8");
  stdin.setRawMode?.(true);

  return new Promise<LaunchWizardResult | null>((resolve) => {
    rendered = launchSelectorDeps.render(
      <LaunchWizardApp
        activeIndex={activeIndex}
        hasPreselectedTarget={!!preselectedTarget}
        items={items}
        previewState={previewState}
        selectedTarget={selectedTarget}
        step={step}
        totalSteps={totalSteps}
        onMounted={onMounted}
      />,
      { stdin, stdout, stderr },
    );

    const finish = (value: LaunchWizardResult | null) => settle(value, resolve);

    rendered.waitUntilExit().then(() => {
      finish(finalResult);
    });
  });
}
