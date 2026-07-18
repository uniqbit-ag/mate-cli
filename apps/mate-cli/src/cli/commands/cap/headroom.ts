import { spawnSync } from "node:child_process";

import { resolveForCapability } from "../../../lib/orchestrator/framework-context";
import type { CapabilityConfig } from "../../../lib/orchestrator/types";
import { ensureUnambiguousCompanion } from "../shared/companion-selection";

export interface HeadroomCapDeps {
  ensureUnambiguousCompanion?: (cwd: string) => Promise<boolean>;
}

/**
 * @command mate cap headroom [...args]
 * @description Forwards `[...args]` to the `headroom` CLI, run from the
 * companion directory. Requires the `headroom` capability to be enabled in
 * `.mate/config/framework.yaml`.
 * @remarks The child process's exit code is propagated via `process.exitCode`.
 */
export async function runHeadroomCapCommand(
  args: string[],
  deps: HeadroomCapDeps = {},
): Promise<void> {
  const ensureCompanion = deps.ensureUnambiguousCompanion ?? ensureUnambiguousCompanion;
  if (!(await ensureCompanion(process.cwd()))) {
    process.exitCode = 1;
    return;
  }

  const { companionPath, configStore } = await resolveForCapability(process.cwd());
  const config = await configStore.load();

  const capability = (config.capabilities ?? []).find(
    (entry: CapabilityConfig) => entry.name === "headroom",
  );

  if (!capability) {
    process.stderr.write("headroom capability is not enabled in .mate/config/framework.yaml\n");
    process.exitCode = 1;
    return;
  }

  const result = spawnSync("headroom", args, { cwd: companionPath, stdio: "inherit" });

  if (result.error) {
    process.stderr.write(`Failed to run headroom: ${result.error.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (result.status !== null) {
    process.exitCode = result.status;
  }
}
