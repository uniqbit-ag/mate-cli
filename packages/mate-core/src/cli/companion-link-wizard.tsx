import { Box, render as inkRender } from "ink";
import { useEffect } from "react";

import { SelectMenu } from "../lib/components/select-menu";
import { TextInputDisplay } from "../lib/components/text-input-display";
import { WizardFooter } from "../lib/components/wizard-footer";
import { WizardHeader } from "../lib/components/wizard-header";
import type { CompanionSource } from "../lib/orchestrator/types";
import { parseRepoLinkInput } from "./wizard-key-input";

export const companionLinkWizardDeps = {
  render: inkRender,
};

export interface CompanionLinkInputs {
  source: CompanionSource;
  gitUrl?: string;
  localPath?: string;
  companionPaths?: string[];
  profile: string;
}

interface SourceStep {
  kind: "select";
  field: "source";
  label: string;
  options: Array<{ key: CompanionSource; label: string }>;
  activeIndex: number;
}

interface CompanionMultiSelectStep {
  kind: "multiselect";
  field: "companionPaths";
  label: string;
  options: string[];
  activeIndex: number;
  selected: Set<string>;
}

interface TextStep {
  kind: "text";
  field: "gitUrl" | "localPath";
  label: string;
  value: string;
  error?: string;
}

interface ProfileStep {
  kind: "select";
  field: "profile";
  label: string;
  options: string[];
  activeIndex: number;
}

type WizardStep = SourceStep | CompanionMultiSelectStep | TextStep | ProfileStep;

interface WizardAppProps {
  step: WizardStep;
  stepNumber: number;
  totalSteps: number;
  onMounted?: () => void;
}

function CompanionLinkWizardApp({ step, stepNumber, totalSteps, onMounted }: WizardAppProps) {
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

  if (step.kind === "multiselect") {
    const enterHint = isLastStep ? "enter confirm" : "enter next";
    const items = step.options.map((option) => ({
      key: option,
      label: option,
      indicator: step.selected.has(option) ? "◉" : "○",
    }));
    return (
      <Box flexDirection="column" width="100%">
        <WizardHeader title={step.label} step={stepNumber} totalSteps={totalSteps} />
        <Box marginTop={1} flexDirection="column">
          <SelectMenu items={items} activeIndex={step.activeIndex} />
        </Box>
        <WizardFooter hint={`space toggle · ↑↓ navigate · ${enterHint}${backHint} · q cancel`} />
      </Box>
    );
  }

  const items =
    step.field === "source"
      ? step.options.map((option) => ({ key: option.key, label: option.label }))
      : step.options.map((option) => ({ key: option, label: option }));

  return (
    <Box flexDirection="column" width="100%">
      <WizardHeader title={step.label} step={stepNumber} totalSteps={totalSteps} />
      <Box marginTop={1} flexDirection="column">
        <SelectMenu items={items} activeIndex={step.activeIndex} />
      </Box>
      <WizardFooter hint={`↑↓ navigate · enter select${backHint} · q cancel`} />
    </Box>
  );
}

export interface CompanionLinkWizardOptions {
  profiles: string[];
  existingCompanions?: string[];
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

function buildSteps(
  source: CompanionSource,
  profiles: string[],
  values: {
    gitUrl: string;
    localPath: string;
    companionPaths: Set<string>;
    companionActiveIndex: number;
  },
  existingCompanions: string[],
): WizardStep[] {
  const sourceOptions: SourceStep["options"] = [
    { key: "git", label: "git" },
    ...(existingCompanions.length > 0
      ? [{ key: "existing" as const, label: "existing companion" }]
      : []),
    { key: "local", label: "local" },
  ];
  const sourceStep: SourceStep = {
    kind: "select",
    field: "source",
    label: "Companion Source",
    options: sourceOptions,
    activeIndex: Math.max(
      0,
      sourceOptions.findIndex((option) => option.key === source),
    ),
  };

  const sourceSpecificStep: TextStep | CompanionMultiSelectStep =
    source === "git"
      ? {
          kind: "text",
          field: "gitUrl",
          label: "Companion Git URL",
          value: values.gitUrl,
        }
      : source === "local"
        ? {
            kind: "text",
            field: "localPath",
            label: "Local Companion Path",
            value: values.localPath,
          }
        : {
            kind: "multiselect",
            field: "companionPaths",
            label: "Existing Companions",
            options: existingCompanions,
            activeIndex: values.companionActiveIndex,
            selected: values.companionPaths,
          };

  if (profiles.length === 1) {
    return [sourceStep, sourceSpecificStep];
  }

  return [
    sourceStep,
    sourceSpecificStep,
    {
      kind: "select",
      field: "profile",
      label: "Profile",
      options: profiles,
      activeIndex: 0,
    },
  ];
}

export async function selectCompanionLinkInputs(
  options: CompanionLinkWizardOptions,
): Promise<CompanionLinkInputs | null> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const profiles = options.profiles;
  const existingCompanions = options.existingCompanions ?? [];

  return new Promise<CompanionLinkInputs | null>((resolve, reject) => {
    let resolved = false;
    let source: CompanionSource = "git";
    const values = {
      gitUrl: "",
      localPath: "",
      companionPaths: new Set<string>(),
      companionActiveIndex: 0,
    };
    let currentStepIndex = 0;
    const keepAlive = setInterval(() => {}, 1 << 30);
    let rendered: ReturnType<typeof inkRender> | undefined;
    let steps = buildSteps(source, profiles, values, existingCompanions);

    const cleanup = () => {
      clearInterval(keepAlive);
      stdin.off("data", onData);
      stdin.pause();
      stdin.unref?.();
      stdin.setRawMode?.(false);
      stdin.unref?.();
    };

    const doResolve = (value: CompanionLinkInputs | null) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(value);
    };

    const buildResult = (): CompanionLinkInputs => {
      const singleProfile = profiles.length === 1 ? profiles[0]! : null;
      const profile =
        singleProfile ??
        ((steps.find((step) => step.kind === "select" && step.field === "profile") as ProfileStep)
          .options[
          (steps.find((step) => step.kind === "select" && step.field === "profile") as ProfileStep)
            .activeIndex
        ] as string);

      return {
        source,
        gitUrl: source === "git" ? values.gitUrl : undefined,
        localPath: source === "local" ? values.localPath : undefined,
        companionPaths: source === "existing" ? [...values.companionPaths] : undefined,
        profile,
      };
    };

    const rerender = () => {
      rendered?.rerender(
        <CompanionLinkWizardApp
          step={steps[currentStepIndex]!}
          stepNumber={currentStepIndex}
          totalSteps={steps.length}
        />,
      );
    };

    const rebuildSteps = () => {
      const previousProfileStep = steps.find(
        (step): step is ProfileStep => step.kind === "select" && step.field === "profile",
      );
      steps = buildSteps(source, profiles, values, existingCompanions);
      const nextProfileStep = steps.find(
        (step): step is ProfileStep => step.kind === "select" && step.field === "profile",
      );
      if (previousProfileStep && nextProfileStep) {
        nextProfileStep.activeIndex = previousProfileStep.activeIndex;
      }
    };

    const onData = (chunk: string) => {
      const step = steps[currentStepIndex]!;

      if (step.kind === "multiselect" && chunk === " ") {
        const option = step.options[step.activeIndex];
        if (option) {
          if (step.selected.has(option)) step.selected.delete(option);
          else step.selected.add(option);
        }
        rerender();
        return;
      }

      const parsed = parseRepoLinkInput(chunk, step.kind === "text" ? "text" : "select");
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
          values[step.field] = step.value;
          rerender();
          return;
        }
        if (parsed.action === "paste") {
          step.value += parsed.text;
          values[step.field] = step.value;
          rerender();
          return;
        }
        if (parsed.action === "backspace") {
          step.value = step.value.slice(0, -1);
          values[step.field] = step.value;
          rerender();
          return;
        }
        if (parsed.action !== "submit" || !step.value.trim()) {
          return;
        }

        if (currentStepIndex < steps.length - 1) {
          currentStepIndex++;
          rerender();
        } else {
          doResolve(buildResult());
          rendered?.unmount();
        }
        return;
      }

      if (parsed.action === "up") {
        step.activeIndex = step.activeIndex === 0 ? step.options.length - 1 : step.activeIndex - 1;
        if (step.kind === "multiselect") values.companionActiveIndex = step.activeIndex;
        rerender();
        return;
      }
      if (parsed.action === "down") {
        step.activeIndex = step.activeIndex === step.options.length - 1 ? 0 : step.activeIndex + 1;
        if (step.kind === "multiselect") values.companionActiveIndex = step.activeIndex;
        rerender();
        return;
      }
      if (parsed.action !== "submit") {
        return;
      }

      if (step.kind === "select" && step.field === "source") {
        source = step.options[step.activeIndex]!.key;
        rebuildSteps();
        if (currentStepIndex < steps.length - 1) {
          currentStepIndex++;
        }
        rerender();
        return;
      }

      if (step.kind === "multiselect") {
        if (step.selected.size === 0) {
          const option = step.options[step.activeIndex];
          if (option) step.selected.add(option);
        }
        if (currentStepIndex < steps.length - 1) {
          currentStepIndex++;
          rerender();
        } else {
          doResolve(buildResult());
          rendered?.unmount();
        }
        return;
      }

      doResolve(buildResult());
      rendered?.unmount();
    };

    const onMounted = () => {
      stdin.on("data", onData);
    };

    try {
      stdin.setEncoding("utf8");
      stdin.resume();
      stdin.ref();
      stdin.setRawMode?.(true);

      rendered = companionLinkWizardDeps.render(
        <CompanionLinkWizardApp
          step={steps[currentStepIndex]!}
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
          reject(new Error("Companion link wizard exited unexpectedly before completion."));
        }
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
