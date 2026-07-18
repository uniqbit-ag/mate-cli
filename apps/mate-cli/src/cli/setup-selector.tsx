import { Box, Text, render as inkRender } from "ink";
import React, { useEffect } from "react";

import { SelectMenu, type SelectMenuItem } from "../lib/components/select-menu";
import { WizardFooter } from "../lib/components/wizard-footer";
import { WizardHeader } from "../lib/components/wizard-header";

import {
  type GitModeSelection,
  type OpenSpecSchemaSelection,
  type SetupSelections,
  applyOpenSpecSchemaSelection,
  DEFAULT_GIT_MODE_SELECTION,
  getOpenSpecSchemaSelection,
  listSetupCapabilityCompatibilities,
  listSetupGitModeCompatibilities,
  listSetupOpenSpecSchemaCompatibilities,
  listSetupPackageManagerCompatibilities,
  listSetupProviderCompatibilities,
} from "../lib/orchestrator/setup-compatibilities";

interface SetupSelectorOptions {
  initialSelections: SetupSelections;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

export type WizardStep = "providers" | "capabilities" | "openspecSchema" | "gitMode";

interface SetupSelectorProps {
  activeIndex: number;
  currentStep: number;
  steps: WizardStep[];
  selectedProviders: Set<string>;
  selectedPackageManagers: Set<string>;
  selectedCapabilities: Set<string>;
  selectedOpenSpecSchema: OpenSpecSchemaSelection;
  selectedGitMode: GitModeSelection;
  onMounted?: () => void;
}

export const setupSelectorDeps = {
  render: inkRender,
};

export interface SetupSelectorItem {
  kind: "provider" | "packageManager" | "capability" | "openspecSchema" | "gitMode";
  id: string;
  label: string;
  description: string;
  language?: string;
  locked?: boolean;
  disabled?: boolean;
}

export interface SetupSelectorState {
  selectedProviders: Set<string>;
  selectedPackageManagers: Set<string>;
  selectedCapabilities: Set<string>;
  selectedOpenSpecSchema: OpenSpecSchemaSelection;
  selectedGitMode: GitModeSelection;
}

const BASE_WIZARD_STEPS: readonly Exclude<WizardStep, "openspecSchema">[] = [
  "providers",
  "capabilities",
  "gitMode",
];

const STEP_DISPLAY_NAMES: Record<WizardStep, string> = {
  providers: "Agents",
  capabilities: "Capabilities",
  openspecSchema: "OpenSpec Schema Profile",
  gitMode: "Git Auto Mode",
};

export const OPENSPEC_SCHEMA_SKIP_MESSAGE = "OpenSpec not selected - skipping";

function hasOpenSpecSelected(selectedCapabilities: Set<string>): boolean {
  return selectedCapabilities.has("openspec");
}

export function getOpenSpecSchemaStepMessage(
  step: WizardStep,
  selectedCapabilities: Set<string>,
): string | null {
  return step === "openspecSchema" && !hasOpenSpecSelected(selectedCapabilities)
    ? OPENSPEC_SCHEMA_SKIP_MESSAGE
    : null;
}

export function buildWizardSteps(options: {
  selectedCapabilities: Set<string>;
  lockOpenSpecSchemaStep?: boolean;
}): WizardStep[] {
  if (!hasOpenSpecSelected(options.selectedCapabilities) && !options.lockOpenSpecSchemaStep) {
    return [...BASE_WIZARD_STEPS];
  }
  return ["providers", "capabilities", "openspecSchema", "gitMode"];
}

export function parseSelectorInput(
  input: string,
): "up" | "down" | "toggle" | "submit" | "cancel" | "back" | null {
  if (input === "[A") return "up";
  if (input === "[B") return "down";
  if (input === "[D") return "back";
  if (input === " ") return "toggle";
  if (input === "\r" || input === "\n") return "submit";
  if (input === "" || input.toLowerCase() === "q" || input === "") return "cancel";
  return null;
}

export function getSelectableItems(
  activeOpenSpecSchema?: OpenSpecSchemaSelection,
): SetupSelectorItem[] {
  return [
    ...listSetupProviderCompatibilities().map((entry) => ({
      kind: "provider" as const,
      id: entry.agent,
      label: entry.label,
      description: entry.description,
    })),
    ...listSetupPackageManagerCompatibilities().map((entry) => ({
      kind: "packageManager" as const,
      id: entry.packageManager,
      label: entry.label,
      description: entry.description,
      language: entry.language,
      locked: entry.locked,
    })),
    ...listSetupCapabilityCompatibilities().map((entry) => ({
      kind: "capability" as const,
      id: entry.capability.name,
      label: entry.label,
      description: entry.description,
    })),
    ...listSetupOpenSpecSchemaCompatibilities(activeOpenSpecSchema).map((entry) => ({
      kind: "openspecSchema" as const,
      id: entry.id,
      label: entry.label,
      description: entry.description,
    })),
    ...listSetupGitModeCompatibilities().map((entry) => ({
      kind: "gitMode" as const,
      id: entry.id,
      label: entry.label,
      description: entry.description,
    })),
  ];
}

export function getItemsForStep(
  step: WizardStep,
  activeOpenSpecSchema?: OpenSpecSchemaSelection,
): SetupSelectorItem[] {
  const kindMap: Record<WizardStep, SetupSelectorItem["kind"]> = {
    providers: "provider",
    capabilities: "capability",
    openspecSchema: "openspecSchema",
    gitMode: "gitMode",
  };
  return getSelectableItems(activeOpenSpecSchema).filter((item) => item.kind === kindMap[step]);
}

export function getDisabledCapabilityIds(selectedPackageManagers: Set<string>): Set<string> {
  return new Set(
    listSetupCapabilityCompatibilities()
      .filter((entry) =>
        entry.requires?.packageManagers.some((name) => !selectedPackageManagers.has(name)),
      )
      .map((entry) => entry.capability.name),
  );
}

function renderIndicator(
  selected: boolean,
  options?: { locked?: boolean; disabled?: boolean; mode?: "multi" | "radio" },
): string {
  if (options?.locked) return "   ";
  if (options?.disabled) return "○";
  return selected ? (options?.mode === "radio" ? "●" : "◉") : "○";
}

export function toggleSelectableItem(
  state: SetupSelectorState,
  current: SetupSelectorItem,
): SetupSelectorState {
  let selectedProviders = new Set(state.selectedProviders);
  let selectedPackageManagers = new Set(state.selectedPackageManagers);
  let selectedCapabilities = new Set(state.selectedCapabilities);

  if (current.kind === "provider") {
    if (selectedProviders.has(current.id)) selectedProviders.delete(current.id);
    else selectedProviders.add(current.id);
  } else if (current.kind === "packageManager") {
    if (current.locked) return state;
    if (selectedPackageManagers.has(current.id)) selectedPackageManagers.delete(current.id);
    else selectedPackageManagers.add(current.id);

    const disabledCapabilityIds = getDisabledCapabilityIds(selectedPackageManagers);
    if (disabledCapabilityIds.size > 0) {
      selectedCapabilities = new Set(
        [...selectedCapabilities].filter(
          (capabilityName) => !disabledCapabilityIds.has(capabilityName),
        ),
      );
    }
  } else if (current.kind === "capability") {
    if (getDisabledCapabilityIds(selectedPackageManagers).has(current.id)) return state;
    if (selectedCapabilities.has(current.id)) selectedCapabilities.delete(current.id);
    else selectedCapabilities.add(current.id);
  }

  return {
    selectedProviders,
    selectedPackageManagers,
    selectedCapabilities,
    selectedOpenSpecSchema: state.selectedOpenSpecSchema,
    selectedGitMode: state.selectedGitMode,
  };
}

export function selectRadioItem(
  state: SetupSelectorState,
  current: SetupSelectorItem,
): SetupSelectorState {
  if (current.kind !== "openspecSchema" && current.kind !== "gitMode") return state;
  return {
    selectedProviders: new Set(state.selectedProviders),
    selectedPackageManagers: new Set(state.selectedPackageManagers),
    selectedCapabilities: new Set(state.selectedCapabilities),
    selectedOpenSpecSchema:
      current.kind === "openspecSchema"
        ? (current.id as OpenSpecSchemaSelection)
        : state.selectedOpenSpecSchema,
    selectedGitMode:
      current.kind === "gitMode" ? (current.id as GitModeSelection) : state.selectedGitMode,
  };
}

function getInitialActiveIndexForStep(
  step: WizardStep,
  selectedOpenSpecSchema: OpenSpecSchemaSelection,
  selectedGitMode: GitModeSelection = DEFAULT_GIT_MODE_SELECTION,
): number {
  if (step !== "openspecSchema" && step !== "gitMode") return 0;
  const items = getItemsForStep(step, selectedOpenSpecSchema);
  const selected = step === "gitMode" ? selectedGitMode : selectedOpenSpecSchema;
  const index = items.findIndex((item) => item.id === selected);
  return index >= 0 ? index : 0;
}

function SetupSelectorApp({
  activeIndex,
  currentStep,
  steps,
  selectedProviders,
  selectedPackageManagers,
  selectedCapabilities,
  selectedOpenSpecSchema,
  selectedGitMode,
  onMounted,
}: SetupSelectorProps) {
  useEffect(() => {
    onMounted?.();
  }, [onMounted]);

  const totalSteps = steps.length;
  const stepKey = steps[currentStep];
  const stepName = STEP_DISPLAY_NAMES[stepKey];
  const disabledCapabilityIds = getDisabledCapabilityIds(selectedPackageManagers);
  const openSpecSkipMessage = getOpenSpecSchemaStepMessage(stepKey, selectedCapabilities);
  const skipMessage = openSpecSkipMessage;
  const showOpenSpecSkipMessage = skipMessage !== null;
  const navigableItems = showOpenSpecSkipMessage
    ? []
    : getItemsForStep(stepKey, selectedOpenSpecSchema);
  const isRadioStep =
    (stepKey === "openspecSchema" || stepKey === "gitMode") && !showOpenSpecSkipMessage;
  const isLastStep = currentStep === totalSteps - 1;
  const enterHint = isLastStep ? "enter confirm" : "enter next";
  const backHint = currentStep > 0 ? " · ← back" : "";
  const footerHint = showOpenSpecSkipMessage
    ? `${enterHint}${backHint} · q cancel`
    : isRadioStep
      ? `↑↓ navigate · enter select · ${enterHint}${backHint} · q cancel`
      : `↑↓ navigate · space toggle · ${enterHint}${backHint} · q cancel`;

  const menuItems: SelectMenuItem[] = navigableItems.flatMap((item): SelectMenuItem[] => {
    if (item.kind === "provider") {
      return [
        {
          key: `provider:${item.id}`,
          label: item.label,
          description: item.description,
          indicator: renderIndicator(selectedProviders.has(item.id)),
        },
      ];
    }
    if (item.kind === "capability") {
      const disabled = disabledCapabilityIds.has(item.id);
      return [
        {
          key: `capability:${item.id}`,
          label: item.label,
          description: item.description,
          indicator: renderIndicator(selectedCapabilities.has(item.id), { disabled }),
          dimColor: disabled,
        },
      ];
    }
    if (item.kind === "openspecSchema") {
      return [
        {
          key: `openspecSchema:${item.id}`,
          label: item.label,
          description: item.description,
          indicator: renderIndicator(selectedOpenSpecSchema === item.id, { mode: "radio" }),
        },
      ];
    }
    if (item.kind === "gitMode") {
      return [
        {
          key: `gitMode:${item.id}`,
          label: item.label,
          description: item.description,
          indicator: renderIndicator(selectedGitMode === item.id, { mode: "radio" }),
        },
      ];
    }
    return [];
  });

  return (
    <Box flexDirection="column" width="100%">
      <WizardHeader title={stepName} step={currentStep} totalSteps={totalSteps} />
      {currentStep === 0 && <Text dimColor>Always installing: bun (node) · uv (python)</Text>}
      <Box marginTop={1} flexDirection="column">
        {showOpenSpecSkipMessage ? (
          <Text dimColor>{skipMessage}</Text>
        ) : (
          <SelectMenu
            items={menuItems}
            activeIndex={activeIndex}
            mode={isRadioStep ? "radio" : "multi"}
          />
        )}
      </Box>
      <WizardFooter hint={footerHint} />
    </Box>
  );
}

export async function selectSetupCompatibilities(
  options: SetupSelectorOptions,
): Promise<SetupSelections | null> {
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  const stderr = options.stderr ?? process.stderr;

  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      "Interactive setup selection requires a TTY. Use --allowed-agent/--package-manager/--capability for automation.",
    );
  }

  // Ref stdin before rendering so the event loop stays alive during the gap
  // between render() returning and React's passive effects calling stdin.ref().
  // In Bun, readline's rl.close() leaves stdin paused/unrefed; if beforeExit
  // fires in that window, Ink unmounts before the user can interact.
  return new Promise<SetupSelections | null>((resolve, reject) => {
    let resolved = false;
    const keepAlive = setInterval(() => {}, 1 << 30);
    let currentStep = 0;
    let activeIndex = 0;
    let selectedProviders = new Set(options.initialSelections.allowedAgents);
    let selectedPackageManagers = new Set(options.initialSelections.packageManagers);
    let selectedCapabilities = new Set(
      options.initialSelections.capabilities.map((entry) => entry.name),
    );
    let selectedOpenSpecSchema =
      options.initialSelections.selectedOpenSpecSchema ??
      getOpenSpecSchemaSelection(options.initialSelections.capabilities);
    let selectedGitMode = options.initialSelections.selectedGitMode;
    let openSpecSchemaStepLocked = hasOpenSpecSelected(selectedCapabilities);
    let rendered: ReturnType<typeof inkRender> | undefined;

    const cleanup = () => {
      clearInterval(keepAlive);
      stdin.off("data", onData);
      stdin.pause();
      stdin.unref?.();
      stdin.setRawMode?.(false);
      stdin.unref?.();
    };

    const doResolve = (value: SetupSelections | null) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(value);
    };

    const getSteps = () =>
      buildWizardSteps({
        selectedCapabilities,
        lockOpenSpecSchemaStep: openSpecSchemaStepLocked,
      });

    const getCurrentStep = () => getSteps()[currentStep];

    const getCurrentItems = () => {
      const step = getCurrentStep();
      return step === "openspecSchema" && !hasOpenSpecSelected(selectedCapabilities)
        ? []
        : getItemsForStep(step, selectedOpenSpecSchema);
    };

    const rerender = () => {
      rendered?.rerender(
        <SetupSelectorApp
          activeIndex={activeIndex}
          currentStep={currentStep}
          steps={getSteps()}
          selectedProviders={selectedProviders}
          selectedPackageManagers={selectedPackageManagers}
          selectedCapabilities={selectedCapabilities}
          selectedOpenSpecSchema={selectedOpenSpecSchema}
          selectedGitMode={selectedGitMode}
        />,
      );
    };

    const onData = (chunk: string) => {
      const action = parseSelectorInput(chunk);
      if (!action) return;

      if (action === "back") {
        if (currentStep === 0) return;
        currentStep--;
        activeIndex = 0;
        rerender();
        return;
      }

      if (action === "up") {
        const stepItems = getCurrentItems();
        if (stepItems.length === 0) return;
        activeIndex = activeIndex === 0 ? stepItems.length - 1 : activeIndex - 1;
        rerender();
        return;
      }

      if (action === "down") {
        const stepItems = getCurrentItems();
        if (stepItems.length === 0) return;
        activeIndex = activeIndex === stepItems.length - 1 ? 0 : activeIndex + 1;
        rerender();
        return;
      }

      if (action === "toggle") {
        const stepItems = getCurrentItems();
        const current = stepItems[activeIndex];
        if (!current || current.kind === "openspecSchema") return;

        const next = toggleSelectableItem(
          {
            selectedProviders,
            selectedPackageManagers,
            selectedCapabilities,
            selectedOpenSpecSchema,
            selectedGitMode,
          },
          current,
        );
        selectedProviders = next.selectedProviders;
        selectedPackageManagers = next.selectedPackageManagers;
        selectedCapabilities = next.selectedCapabilities;
        selectedOpenSpecSchema = next.selectedOpenSpecSchema;
        selectedGitMode = next.selectedGitMode;
        activeIndex = Math.max(0, Math.min(activeIndex, getCurrentItems().length - 1));
        rerender();
        return;
      }

      if (action === "submit") {
        const stepKey = getCurrentStep();
        if (
          (stepKey === "openspecSchema" && hasOpenSpecSelected(selectedCapabilities)) ||
          stepKey === "gitMode"
        ) {
          const current = getCurrentItems()[activeIndex];
          const selectedRadioValue =
            stepKey === "gitMode" ? selectedGitMode : selectedOpenSpecSchema;
          if (current && current.id !== selectedRadioValue) {
            const next = selectRadioItem(
              {
                selectedProviders,
                selectedPackageManagers,
                selectedCapabilities,
                selectedOpenSpecSchema,
                selectedGitMode,
              },
              current,
            );
            selectedProviders = next.selectedProviders;
            selectedPackageManagers = next.selectedPackageManagers;
            selectedCapabilities = next.selectedCapabilities;
            selectedOpenSpecSchema = next.selectedOpenSpecSchema;
            selectedGitMode = next.selectedGitMode;
            rerender();
            return;
          }
        }

        if (stepKey === "capabilities" && hasOpenSpecSelected(selectedCapabilities)) {
          openSpecSchemaStepLocked = true;
        }

        const steps = getSteps();
        if (currentStep < steps.length - 1) {
          currentStep++;
          activeIndex = getInitialActiveIndexForStep(
            steps[currentStep],
            selectedOpenSpecSchema,
            selectedGitMode,
          );
          rerender();
          return;
        }
        doResolve({
          allowedAgents: [...selectedProviders],
          packageManagers: [...selectedPackageManagers],
          capabilities: applyOpenSpecSchemaSelection(
            listSetupCapabilityCompatibilities()
              .filter((entry) => selectedCapabilities.has(entry.capability.name))
              .map((entry) => entry.capability),
            selectedOpenSpecSchema,
          ),
          selectedOpenSpecSchema,
          selectedGitMode,
        });
        rendered?.unmount();
        return;
      }

      doResolve(null);
      rendered?.unmount();
    };

    // Attach the stdin data listener only after the first Ink frame renders.
    // This drains any stdin data buffered before the selector was visible
    // (e.g. the Enter key the user pressed to launch `mate companion setup`), preventing
    // an accidental immediate submit.
    const onMounted = () => {
      stdin.on("data", onData);
    };

    try {
      stdin.setEncoding("utf8");
      stdin.resume();
      stdin.ref();
      stdin.setRawMode?.(true);

      rendered = setupSelectorDeps.render(
        <SetupSelectorApp
          activeIndex={activeIndex}
          currentStep={currentStep}
          steps={getSteps()}
          selectedProviders={selectedProviders}
          selectedPackageManagers={selectedPackageManagers}
          selectedCapabilities={selectedCapabilities}
          selectedOpenSpecSchema={selectedOpenSpecSchema}
          selectedGitMode={selectedGitMode}
          onMounted={onMounted}
        />,
        { stdin, stdout, stderr, exitOnCtrlC: true, interactive: true },
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
          reject(
            new Error(
              "Interactive setup selector exited unexpectedly before a selection was made.",
            ),
          );
        }
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
