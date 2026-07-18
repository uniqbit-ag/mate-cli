import React, { useState } from "react";
import { Box, Text, render } from "ink";

import { useSpinnerFrame } from "../lib/components/spinner";
import { MIDNIGHT_PURPLE, MIDNIGHT_PURPLE_BRIGHT } from "../lib/components/theme";
import type { InstallPlan, InstallPlanItem, InstallRequirementResult } from "../lib/install";
import { runInstallPlan } from "../lib/install";

type DisplayStatus = "ready" | "pending" | "installing" | "installed" | "skipped" | "failed";

function statusForItem(item: InstallPlanItem): DisplayStatus {
  return item.satisfied ? "ready" : "pending";
}

function statusIcon(status: DisplayStatus): string {
  switch (status) {
    case "ready":
    case "skipped":
    case "installed":
      return "✓";
    case "failed":
      return "✗";
    case "installing":
      return "⟳";
    default:
      return "○";
  }
}

function statusLabel(status: DisplayStatus): string {
  switch (status) {
    case "ready":
      return "ready";
    case "skipped":
      return "already installed";
    case "installed":
      return "installed";
    case "failed":
      return "failed";
    case "installing":
      return "installing";
    default:
      return "queued";
  }
}

function statusColor(status: DisplayStatus): string | undefined {
  if (status === "failed") return "red";
  if (status === "installing") return "yellow";
  if (status === "ready" || status === "skipped" || status === "installed") return "green";
  return undefined;
}

function InstallHeader({
  plan,
  completed,
  total,
}: {
  plan: InstallPlan;
  completed: number;
  total: number;
}) {
  const contextLabel = plan.context.kind === "core" ? "core environment" : "companion environment";
  const progress = total === 0 ? 1 : completed / total;
  const filled = Math.round(progress * 20);

  return (
    <Box
      borderStyle="round"
      borderColor={MIDNIGHT_PURPLE}
      paddingX={2}
      paddingY={1}
      flexDirection="column"
    >
      <Box justifyContent="space-between">
        <Text bold color={MIDNIGHT_PURPLE_BRIGHT}>
          MATE / INSTALLATION
        </Text>
        <Text color={MIDNIGHT_PURPLE_BRIGHT}>{contextLabel}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Preparing your environment</Text>
        <Text dimColor>
          {plan.context.message ?? "Checking your environment and companion tools"}
        </Text>
      </Box>
      <Box marginTop={1} justifyContent="space-between">
        <Text dimColor>INSTALLATION PROGRESS</Text>
        <Text color="cyan">
          {completed}/{total}
        </Text>
      </Box>
      <Text color={completed === total ? "green" : MIDNIGHT_PURPLE}>
        {"[" + "█".repeat(filled) + "░".repeat(20 - filled) + "]"}
      </Text>
    </Box>
  );
}

function RequirementRow({
  item,
  status,
  spinner,
}: {
  item: InstallPlanItem;
  status: DisplayStatus;
  spinner: string;
}) {
  return (
    <Box>
      <Text color={statusColor(status)}>{` ${statusIcon(status)} `}</Text>
      <Box width={26}>
        <Text bold={status === "installing"}>{item.label}</Text>
      </Box>
      <Text color={statusColor(status)} dimColor={status === "pending"}>
        {status === "installing" ? `${spinner} ${statusLabel(status)}` : statusLabel(status)}
      </Text>
    </Box>
  );
}

function RequirementGroup({
  label,
  items,
  statuses,
  spinner,
}: {
  label: string;
  items: InstallPlanItem[];
  statuses: Record<string, DisplayStatus>;
  spinner: string;
}) {
  if (items.length === 0) return null;
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column" marginTop={1}>
      <Text bold color={MIDNIGHT_PURPLE_BRIGHT}>
        {label}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {items.map((item) => (
          <RequirementRow key={item.id} item={item} status={statuses[item.id]} spinner={spinner} />
        ))}
      </Box>
    </Box>
  );
}

function InstallExecutionView({
  plan,
  onDone,
}: {
  plan: InstallPlan;
  onDone: (execution: { ok: boolean; results: InstallRequirementResult[] }) => void;
}) {
  const [statuses, setStatuses] = useState<Record<string, DisplayStatus>>(() =>
    Object.fromEntries(plan.requirements.map((item) => [item.id, statusForItem(item)])),
  );
  const spinner = useSpinnerFrame(true);

  React.useEffect(() => {
    let active = true;
    void runInstallPlan(plan, {
      onStart: (item) => {
        if (active)
          setStatuses((current) => ({
            ...current,
            [item.id]: item.satisfied ? "skipped" : "installing",
          }));
      },
      onProgress: (item, result) => {
        if (active) setStatuses((current) => ({ ...current, [item.id]: result.status }));
      },
    }).then((execution) => {
      if (active) onDone(execution);
    });
    return () => {
      active = false;
    };
  }, [onDone, plan]);

  const completed = Object.values(statuses).filter((status) =>
    ["ready", "installed", "skipped", "failed"].includes(status),
  ).length;

  return (
    <Box flexDirection="column">
      <InstallHeader plan={plan} completed={completed} total={plan.requirements.length} />
      <RequirementGroup
        label="01  CORE REQUIREMENTS"
        items={plan.requirements.filter((item) => item.group === "core")}
        statuses={statuses}
        spinner={spinner}
      />
      <RequirementGroup
        label="02  COMPANION REQUIREMENTS"
        items={plan.requirements.filter((item) => item.group === "companion")}
        statuses={statuses}
        spinner={spinner}
      />
      <Box marginTop={1}>
        <Text dimColor>
          {completed === plan.requirements.length ? "Finalizing installation..." : "Working..."}
        </Text>
      </Box>
    </Box>
  );
}

export async function renderInstallExecution(
  plan: InstallPlan,
): Promise<{ ok: boolean; results: InstallRequirementResult[] }> {
  return new Promise((resolve) => {
    let app: ReturnType<typeof render> | undefined;
    const finish = (execution: { ok: boolean; results: InstallRequirementResult[] }) => {
      app?.unmount();
      resolve(execution);
    };
    app = render(<InstallExecutionView plan={plan} onDone={finish} />);
  });
}
