import { Box, render as inkRender } from "ink";
import React, { useEffect } from "react";

import { SelectMenu } from "../lib/components/select-menu";
import { TextInputDisplay } from "../lib/components/text-input-display";
import { WizardFooter } from "../lib/components/wizard-footer";
import { WizardHeader } from "../lib/components/wizard-header";
import { parseRepoLinkInput } from "./wizard-key-input";

export const artifactLinkWizardDeps = {
  render: inkRender,
};

export interface ArtifactLinkInputs {
  gitUrl: string;
  profile: string;
}

interface TextStep {
  kind: "text";
  field: "gitUrl";
  label: string;
  value: string;
  error?: string;
}

interface SelectStep {
  kind: "select";
  field: "profile";
  label: string;
  options: string[];
  activeIndex: number;
}

type WizardStep = TextStep | SelectStep;

interface WizardAppProps {
  step: WizardStep;
  stepNumber: number;
  totalSteps: number;
  onMounted?: () => void;
}

function ArtifactLinkWizardApp({ step, stepNumber, totalSteps, onMounted }: WizardAppProps) {
  useEffect(() => {
    onMounted?.();
  }, [onMounted]);

  const isLastStep = stepNumber === totalSteps - 1;
  const backHint = stepNumber > 0 ? " · ← back" : "";

  if (step.kind === "text") {
    const enterHint = isLastStep ? "enter confirm" : "enter next";
    return (
      <Box flexDirection="column" width="100%">
        <WizardHeader title={step.label} step={stepNumber} totalSteps={totalSteps} />
        <TextInputDisplay value={step.value} error={step.error} />
        <WizardFooter hint={`${enterHint}${backHint} · q cancel`} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      <WizardHeader title={step.label} step={stepNumber} totalSteps={totalSteps} />
      <Box marginTop={1} flexDirection="column">
        <SelectMenu
          items={step.options.map((opt) => ({ key: opt, label: opt }))}
          activeIndex={step.activeIndex}
        />
      </Box>
      <WizardFooter hint={`↑↓ navigate · enter select${backHint} · q cancel`} />
    </Box>
  );
}

export interface ArtifactLinkWizardOptions {
  profiles: string[];
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

export async function selectArtifactLinkInputs(
  options: ArtifactLinkWizardOptions,
): Promise<ArtifactLinkInputs | null> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const { profiles } = options;

  const singleProfile = profiles.length === 1 ? profiles[0] : null;

  const gitUrlStep: TextStep = {
    kind: "text",
    field: "gitUrl",
    label: "Git URL",
    value: "",
  };
  const steps: WizardStep[] = singleProfile
    ? [gitUrlStep]
    : [
        gitUrlStep,
        { kind: "select", field: "profile", label: "Profile", options: profiles, activeIndex: 0 },
      ];

  return new Promise<ArtifactLinkInputs | null>((resolve, reject) => {
    let resolved = false;
    let currentStepIndex = 0;
    const keepAlive = setInterval(() => {}, 1 << 30);
    let rendered: ReturnType<typeof inkRender> | undefined;

    const cleanup = () => {
      clearInterval(keepAlive);
      stdin.off("data", onData);
      stdin.pause();
      stdin.unref?.();
      stdin.setRawMode?.(false);
      stdin.unref?.();
    };

    const doResolve = (value: ArtifactLinkInputs | null) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(value);
    };

    const buildResult = (): ArtifactLinkInputs => {
      const gitUrlS = steps.find((s) => s.kind === "text" && s.field === "gitUrl") as TextStep;
      const profile =
        singleProfile ??
        (() => {
          const sel = steps.find((s) => s.kind === "select") as SelectStep;
          return sel.options[sel.activeIndex];
        })();
      return { gitUrl: gitUrlS.value, profile };
    };

    const rerender = () => {
      rendered?.rerender(
        <ArtifactLinkWizardApp
          step={steps[currentStepIndex]}
          stepNumber={currentStepIndex}
          totalSteps={steps.length}
        />,
      );
    };

    const onData = (chunk: string) => {
      const step = steps[currentStepIndex];
      const parsed = parseRepoLinkInput(chunk, step.kind);
      if (!parsed) return;

      if (parsed.action === "cancel") {
        doResolve(null);
        rendered?.unmount();
        return;
      }

      if (parsed.action === "back") {
        if (currentStepIndex === 0) return;
        currentStepIndex--;
        rerender();
        return;
      }

      if (step.kind === "text") {
        if (parsed.action === "char") {
          step.value += parsed.char;
          rerender();
          return;
        }
        if (parsed.action === "paste") {
          step.value += parsed.text;
          rerender();
          return;
        }
        if (parsed.action === "backspace") {
          step.value = step.value.slice(0, -1);
          rerender();
          return;
        }
        if (parsed.action === "submit") {
          if (!step.value.trim()) return;

          if (currentStepIndex < steps.length - 1) {
            currentStepIndex++;
            rerender();
          } else {
            doResolve(buildResult());
            rendered?.unmount();
          }
          return;
        }
        return;
      }

      // select step
      const sel = step as SelectStep;
      if (parsed.action === "up") {
        sel.activeIndex = sel.activeIndex === 0 ? sel.options.length - 1 : sel.activeIndex - 1;
        rerender();
        return;
      }
      if (parsed.action === "down") {
        sel.activeIndex = sel.activeIndex === sel.options.length - 1 ? 0 : sel.activeIndex + 1;
        rerender();
        return;
      }
      if (parsed.action === "submit") {
        doResolve(buildResult());
        rendered?.unmount();
        return;
      }
    };

    const onMounted = () => {
      stdin.on("data", onData);
    };

    try {
      stdin.setEncoding("utf8");
      stdin.resume();
      stdin.ref();
      stdin.setRawMode?.(true);

      rendered = artifactLinkWizardDeps.render(
        <ArtifactLinkWizardApp
          step={steps[currentStepIndex]}
          stepNumber={currentStepIndex}
          totalSteps={steps.length}
          onMounted={onMounted}
        />,
        { stdin, stdout, stderr, exitOnCtrlC: true },
      );
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }

    rendered.waitUntilExit().then(
      () => {
        if (!resolved) {
          cleanup();
          reject(new Error("Artifact link wizard exited unexpectedly before completion."));
        }
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
