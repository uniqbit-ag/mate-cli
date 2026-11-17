import os from "node:os";
import path from "node:path";

import { isCommandOnPath, runCommand, runShellCommand } from "../utils";
import type { Plugin } from "../plugin";

/** PATH plus where Bun's own installer puts the binary: $BUN_INSTALL/bin, else ~/.bun/bin. */
function bunPath(): string {
  const installBin = path.join(process.env.BUN_INSTALL || path.join(os.homedir(), ".bun"), "bin");
  return [process.env.PATH ?? "", installBin].filter(Boolean).join(path.delimiter);
}

function bunInstallPlan(): { command: string; install: () => Promise<void> } {
  const pathValue = bunPath();
  if (process.platform === "darwin" && isCommandOnPath("brew", pathValue)) {
    return {
      command: "brew install oven-sh/bun/bun",
      install: () => runCommand("brew", ["install", "oven-sh/bun/bun"]),
    };
  }
  if (process.platform === "win32") {
    const command = 'powershell -ExecutionPolicy Bypass -c "irm bun.sh/install.ps1 | iex"';
    return {
      command,
      install: () =>
        runCommand("powershell", [
          "-ExecutionPolicy",
          "Bypass",
          "-c",
          "irm bun.sh/install.ps1 | iex",
        ]),
    };
  }
  const command = "curl -fsSL https://bun.sh/install | bash";
  return { command, install: () => runShellCommand(command) };
}

export function createBunPlugin(): Plugin {
  return {
    id: "bun",
    kind: "packageManager",
    label: "bun",
    description: "Framework runtime package manager for Node.js workflows.",
    defaultSelected: true,
    isEnabled: (config) => (config.packageManagers ?? ["bun"]).includes("bun"),
    async apply() {},
    async teardown() {},
    getInstallRequirements: () => {
      const plan = bunInstallPlan();
      return [
        {
          id: "core:bun",
          label: "Bun runtime",
          group: "core",
          source: "Mate runtime",
          command: plan.command,
          fingerprint: `bun:${process.platform}:${plan.command}`,
          detect: () =>
            isCommandOnPath(process.platform === "win32" ? "bun.exe" : "bun", bunPath()),
          install: plan.install,
          verify: () =>
            isCommandOnPath(process.platform === "win32" ? "bun.exe" : "bun", bunPath()),
        },
      ];
    },
  };
}
