import os from "node:os";

import { isCommandOnPath, runCommand, runShellCommand } from "../utils";
import type { Plugin } from "../plugin";

function bunPath(): string {
  const extra = process.platform === "win32" ? pathSeparator() : `${os.homedir()}/.bun/bin`;
  return [process.env.PATH ?? "", extra].filter(Boolean).join(pathSeparator());
}

function pathSeparator(): string {
  return process.platform === "win32" ? ";" : ":";
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

export const bunPlugin: Plugin = {
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
        detect: () => isCommandOnPath("bun", bunPath()),
        install: plan.install,
        verify: () => isCommandOnPath("bun", bunPath()),
      },
    ];
  },
};
