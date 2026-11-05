/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { Box, Static, Text, render } from "ink";

import { BRAND_ACCENT } from "../brand/palette";
import { useSpinnerFrame } from "../lib/components/spinner";
import type { InstallPlan, InstallPlanItem, InstallRequirementResult } from "../lib/install";
import { runInstallPlan } from "../lib/install";

type Execution = { ok: boolean; results: InstallRequirementResult[] };

interface FinishedRow {
  item: InstallPlanItem;
  result: InstallRequirementResult;
  durationMs: number;
}

type LogEntry = { key: string; header: string; message?: string } | (FinishedRow & { key: string });

const STATUS_WORD: Record<InstallRequirementResult["status"], string> = {
  skipped: "present",
  installed: "installed",
  failed: "failed",
};

/** Durations under a second are noise; show whole seconds above it. */
function formatDuration(ms: number): string | undefined {
  if (ms < 1000) return undefined;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function firstLine(text: string | undefined): string {
  return (text ?? "unknown error").split("\n", 1)[0].trim();
}

function ResultRow({ row, labelWidth }: { row: FinishedRow; labelWidth: number }) {
  const failed = row.result.status === "failed";
  const duration = formatDuration(row.durationMs);
  return (
    <Text wrap="truncate-end">
      {"  "}
      {failed ? <Text color="red">✗</Text> : <Text color={BRAND_ACCENT}>✓</Text>}{" "}
      {row.item.label.padEnd(labelWidth)}
      {"  "}
      {failed ? <Text color="red">failed</Text> : STATUS_WORD[row.result.status]}
      {duration ? <Text dimColor>{`  ${duration}`}</Text> : null}
      {failed ? <Text dimColor>{`  ${firstLine(row.result.error)}`}</Text> : null}
    </Text>
  );
}

function useElapsedMs(startedAt: number): number {
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now - startedAt;
}

function LiveRow({
  item,
  startedAt,
  labelWidth,
  done,
  total,
}: {
  item: InstallPlanItem;
  startedAt: number;
  labelWidth: number;
  done: number;
  total: number;
}) {
  const spinner = useSpinnerFrame(true);
  const duration = formatDuration(useElapsedMs(startedAt));
  return (
    <Box justifyContent="space-between">
      <Text wrap="truncate-end">
        {"  "}
        <Text color={BRAND_ACCENT}>{spinner}</Text> {item.label.padEnd(labelWidth)}
        {"  "}
        <Text dimColor>
          {item.command}
          {duration ? `  ${duration}` : ""}
        </Text>
      </Text>
      <Box flexShrink={0} marginLeft={2}>
        <Text dimColor>
          {done} / {total}
        </Text>
      </Box>
    </Box>
  );
}

export function InstallExecutionView({
  plan,
  onDone,
}: {
  plan: InstallPlan;
  onDone: (execution: Execution) => void;
}) {
  const header = `install · ${plan.context.kind === "core" ? "core" : "companion"}`;
  const [log, setLog] = useState<LogEntry[]>(() => [
    { key: "header", header, message: plan.context.message },
  ]);
  const [running, setRunning] = useState<{ item: InstallPlanItem; startedAt: number }>();
  const [execution, setExecution] = useState<Execution>();
  const labelWidth = Math.max(0, ...plan.requirements.map((item) => item.label.length));

  useEffect(() => {
    let active = true;
    const startedAt = new Map<string, number>();
    void runInstallPlan(plan, {
      onStart: (item) => {
        const now = Date.now();
        startedAt.set(item.id, now);
        if (active && !item.satisfied) setRunning({ item, startedAt: now });
      },
      onProgress: (item, result) => {
        const durationMs = Date.now() - (startedAt.get(item.id) ?? Date.now());
        if (!active) return;
        setRunning(undefined);
        setLog((current) => [...current, { key: item.id, item, result, durationMs }]);
      },
    }).then((result) => {
      if (active) setExecution(result);
    });
    return () => {
      active = false;
    };
  }, [plan]);

  // Report only after the last row is committed, so unmounting cannot drop it.
  useEffect(() => {
    if (execution) onDone(execution);
  }, [execution, onDone]);

  return (
    <Box flexDirection="column">
      <Static items={log}>
        {(entry) =>
          "header" in entry ? (
            <Box key={entry.key} flexDirection="column">
              <Text wrap="truncate-end">
                <Text bold color={BRAND_ACCENT}>
                  mate
                </Text>{" "}
                {entry.header}
              </Text>
              {entry.message ? (
                <Text dimColor wrap="truncate-end">
                  {entry.message}
                </Text>
              ) : null}
            </Box>
          ) : (
            <ResultRow key={entry.key} row={entry} labelWidth={labelWidth} />
          )
        }
      </Static>
      {running ? (
        <LiveRow
          key={running.item.id}
          item={running.item}
          startedAt={running.startedAt}
          labelWidth={labelWidth}
          done={log.length - 1}
          total={plan.requirements.length}
        />
      ) : null}
    </Box>
  );
}

export async function renderInstallExecution(plan: InstallPlan): Promise<Execution> {
  return new Promise((resolve) => {
    let app: ReturnType<typeof render> | undefined;
    const finish = (execution: Execution) => {
      app?.unmount();
      resolve(execution);
    };
    app = render(<InstallExecutionView plan={plan} onDone={finish} />);
  });
}
