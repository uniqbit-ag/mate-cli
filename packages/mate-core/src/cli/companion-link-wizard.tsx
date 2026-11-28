/** @jsxRuntime automatic */
/** @jsxImportSource react */
import path from "node:path";

import { Box, render as inkRender } from "ink";
import { useEffect } from "react";

import { SelectMenu } from "../lib/components/select-menu";
import { TextInputDisplay } from "../lib/components/text-input-display";
import { WizardFooter } from "../lib/components/wizard-footer";
import { WizardHeader } from "../lib/components/wizard-header";
import type { CompanionSource } from "../lib/orchestrator/types";
import { parseRepoLinkInput } from "./wizard-key-input";

const companionLinkWizardDeps = {
  render: inkRender,
};

export interface CompanionLinkInputs {
  source: CompanionSource;
  gitUrl?: string;
  /** A clone already on this machine whose origin is `gitUrl`'s repository; links it instead of cloning. */
  clonePath?: string;
  localPath?: string;
  companionPaths?: string[];
  /** True replaces the companions `replacedBy` names, false keeps both. */
  replace?: boolean;
}

export interface ExistingCompanion {
  path: string;
  registered: boolean;
}

interface SelectStep {
  kind: "select";
  field: "source" | "clonePath" | "replace";
  label: string;
  options: Array<{ key: string; label: string }>;
  activeIndex: number;
}

interface CompanionMultiSelectStep {
  kind: "multiselect";
  field: "companionPaths";
  label: string;
  options: Array<{ key: string; label: string }>;
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

type WizardStep = SelectStep | CompanionMultiSelectStep | TextStep;

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
      ...option,
      indicator: step.selected.has(option.key) ? "◉" : "○",
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

  const items = step.options.map((option) => ({ key: option.key, label: option.label }));

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
  existingCompanions?: ExistingCompanion[];
  /** Existing companions whose origin is the URL's repository. */
  clonesOf?: (gitUrl: string) => string[];
  /** The linked companions these inputs would replace; empty asks nothing. */
  replacedBy?: (inputs: CompanionLinkInputs) => string[];
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

const REPLACE = "replace";

interface WizardValues {
  source: CompanionSource;
  gitUrl: string;
  /** Into the matching clones; their count means "Clone a new copy". */
  cloneActiveIndex: number;
  localPath: string;
  companionPaths: Set<string>;
  companionActiveIndex: number;
  replace: boolean;
}

function resultOf(
  values: WizardValues,
  clonesOf: (gitUrl: string) => string[],
): CompanionLinkInputs {
  const { source } = values;
  return {
    source,
    gitUrl: source === "git" ? values.gitUrl : undefined,
    clonePath: source === "git" ? clonesOf(values.gitUrl)[values.cloneActiveIndex] : undefined,
    localPath: source === "local" ? values.localPath : undefined,
    companionPaths: source === "existing" ? [...values.companionPaths] : undefined,
    replace: values.replace,
  };
}

function buildSteps(
  values: WizardValues,
  options: Required<Pick<CompanionLinkWizardOptions, "clonesOf" | "replacedBy">> & {
    existingCompanions: ExistingCompanion[];
  },
): WizardStep[] {
  const { existingCompanions, clonesOf, replacedBy } = options;
  const sourceOptions: SelectStep["options"] = [
    ...(existingCompanions.length > 0
      ? [{ key: "existing", label: "Use a companion already on this machine" }]
      : []),
    { key: "git", label: "Clone from a Git URL into ~/.mate/companions" },
    { key: "local", label: "Enter the path of another folder" },
  ];
  const steps: WizardStep[] = [
    {
      kind: "select",
      field: "source",
      label: "Companion Source",
      options: sourceOptions,
      activeIndex: Math.max(
        0,
        sourceOptions.findIndex((option) => option.key === values.source),
      ),
    },
  ];

  const clones = values.source === "git" ? clonesOf(values.gitUrl) : [];
  if (values.source === "git") {
    steps.push({ kind: "text", field: "gitUrl", label: "Companion Git URL", value: values.gitUrl });
    if (clones.length > 0) {
      steps.push({
        kind: "select",
        field: "clonePath",
        label: "This repository is already cloned on this machine",
        options: [
          ...clones.map((clone) => ({
            key: clone,
            label: `Use ${path.basename(clone)}  ${clone}`,
          })),
          { key: "new", label: "Clone a new copy" },
        ],
        activeIndex: Math.min(values.cloneActiveIndex, clones.length),
      });
    }
  } else if (values.source === "local") {
    steps.push({
      kind: "text",
      field: "localPath",
      label: "Local Companion Path",
      value: values.localPath,
    });
  } else {
    steps.push({
      kind: "multiselect",
      field: "companionPaths",
      label: "Existing Companions",
      options: existingCompanions.map((companion) => ({
        key: companion.path,
        // Name and mark lead: the menu cuts long paths at the terminal's edge.
        label: `${path.basename(companion.path)}${companion.registered ? "" : " (not registered)"}  ${companion.path}`,
      })),
      activeIndex: values.companionActiveIndex,
      selected: values.companionPaths,
    });
  }

  const replaced = replacedBy(resultOf(values, clonesOf));
  if (replaced.length > 0) {
    steps.push({
      kind: "select",
      field: "replace",
      label: "This folder is already linked to another companion",
      options: [
        {
          key: REPLACE,
          label: `Replace ${replaced.map((companion) => path.basename(companion)).join(", ")}`,
        },
        { key: "keep", label: "Keep both" },
      ],
      activeIndex: values.replace ? 0 : 1,
    });
  }
  return steps;
}

export async function selectCompanionLinkInputs(
  options: CompanionLinkWizardOptions,
): Promise<CompanionLinkInputs | null> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const existingCompanions = options.existingCompanions ?? [];
  const stepOptions = {
    existingCompanions,
    clonesOf: options.clonesOf ?? (() => []),
    replacedBy: options.replacedBy ?? (() => []),
  };

  return new Promise<CompanionLinkInputs | null>((resolve, reject) => {
    let resolved = false;
    const values: WizardValues = {
      source: existingCompanions.length > 0 ? "existing" : "git",
      gitUrl: "",
      cloneActiveIndex: 0,
      localPath: "",
      companionPaths: new Set<string>(),
      companionActiveIndex: 0,
      replace: true,
    };
    let currentStepIndex = 0;
    const keepAlive = setInterval(() => {}, 1 << 30);
    let rendered: ReturnType<typeof inkRender> | undefined;
    let steps = buildSteps(values, stepOptions);

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

    const rerender = () => {
      rendered?.rerender(
        <CompanionLinkWizardApp
          step={steps[currentStepIndex]!}
          stepNumber={currentStepIndex}
          totalSteps={steps.length}
        />,
      );
    };

    // Later steps depend on earlier answers, so every submit rebuilds them.
    const advance = () => {
      steps = buildSteps(values, stepOptions);
      if (currentStepIndex < steps.length - 1) {
        currentStepIndex++;
        rerender();
        return;
      }
      doResolve(resultOf(values, stepOptions.clonesOf));
      rendered?.unmount();
    };

    const onData = (chunk: string) => {
      const step = steps[currentStepIndex]!;

      if (step.kind === "multiselect" && chunk === " ") {
        const option = step.options[step.activeIndex];
        if (option) {
          if (step.selected.has(option.key)) step.selected.delete(option.key);
          else step.selected.add(option.key);
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
        advance();
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

      if (step.kind === "select") {
        const key = step.options[step.activeIndex]!.key;
        if (step.field === "source") values.source = key as CompanionSource;
        else if (step.field === "clonePath") values.cloneActiveIndex = step.activeIndex;
        else values.replace = key === REPLACE;
        advance();
        return;
      }

      if (step.selected.size === 0) {
        const option = step.options[step.activeIndex];
        if (option) step.selected.add(option.key);
      }
      advance();
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
