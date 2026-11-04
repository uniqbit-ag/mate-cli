import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { isDeclinedByMember, type ReadMemberChoices } from "../../../lib/member-choices";
import type { Plugin, SetupContext } from "../plugin";
import type { InstallRequirement } from "../install-contract";
import { confirm } from "../../../cli/confirm";
import { isCommandOnPath, runCommand, runShellCommand } from "../utils";

export function isInstalledViaUvTool(pkgName: string): boolean {
  try {
    const output = execFileSync("uv", ["tool", "list"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.includes(pkgName);
  } catch {
    return false;
  }
}

/** Capabilities whose installers run through uv; uv is installed only for them. */
export const UV_DEPENDENT_CAPABILITIES = ["graphify"];

export function isUvNeeded(config: { capabilities?: { name: string }[] }): boolean {
  return (config.capabilities ?? []).some((capability) =>
    UV_DEPENDENT_CAPABILITIES.includes(capability.name),
  );
}

/**
 * Directories the uv installer may put `uv` (and `uv tool` binaries) in, in
 * its own precedence order. The installer only edits shell profiles, so a
 * fresh install is not on this process's PATH yet.
 */
export function uvInstallDirs(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string[] {
  const dirs = [
    env.UV_INSTALL_DIR,
    env.XDG_BIN_HOME,
    env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, "..", "bin") : undefined,
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
  ];
  return [...new Set(dirs.filter((dir): dir is string => Boolean(dir)))];
}

export interface PackageManagerSetupDeps {
  confirm?: typeof confirm;
  isCommandOnPath?: (command: string, pathValue: string) => boolean;
  pathValue?: string;
  platform?: NodeJS.Platform;
  runCommand?: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
  runShellCommand?: (command: string, options?: { cwd?: string }) => Promise<void>;
  /** Install locations probed when uv is not on PATH; defaults to {@link uvInstallDirs}. */
  installDirs?: string[];
  readMemberChoices?: ReadMemberChoices;
}

const UV_GITIGNORE_ENTRIES = [
  "# python / uv",
  ".venv/",
  ".uv/",
  "__pycache__/",
  "*.py[cod]",
  "*.egg-info/",
  "build/",
  "dist/",
];

export function createUvPlugin(deps: PackageManagerSetupDeps = {}): Plugin & { language: string } {
  const askConfirm = deps.confirm ?? confirm;
  const onPath = deps.isCommandOnPath ?? isCommandOnPath;
  const platform = deps.platform ?? process.platform;
  const execCommand = deps.runCommand ?? runCommand;
  const execShellCommand = deps.runShellCommand ?? runShellCommand;
  const currentPath = () => deps.pathValue ?? process.env.PATH ?? "";

  /**
   * Find uv on PATH or in an install location. A uv found only in an install
   * location joins this process's PATH, so the installers that run through
   * it later in the same run (`uv tool install graphifyy`) find uv and the
   * tool binaries it puts next to itself.
   */
  function locateUv(): boolean {
    if (onPath("uv", currentPath())) return true;
    const dir = (deps.installDirs ?? uvInstallDirs()).find((candidate) => onPath("uv", candidate));
    if (!dir) return false;
    if (deps.pathValue === undefined) {
      process.env.PATH = [dir, process.env.PATH].filter(Boolean).join(path.delimiter);
    }
    return true;
  }

  function installPlan(): { command: string; install: () => Promise<void> } {
    const pathValue = deps.pathValue ?? process.env.PATH ?? "";
    if (platform === "darwin" && onPath("brew", pathValue)) {
      return { command: "brew install uv", install: () => execCommand("brew", ["install", "uv"]) };
    }
    if (platform === "win32") {
      const command = `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`;
      return {
        command,
        install: () =>
          execCommand("powershell", [
            "-ExecutionPolicy",
            "ByPass",
            "-c",
            "irm https://astral.sh/uv/install.ps1 | iex",
          ]),
      };
    }
    if (platform === "linux" || platform === "darwin") {
      const command = "curl -LsSf https://astral.sh/uv/install.sh | sh";
      return { command, install: () => execShellCommand(command) };
    }
    throw new Error(`Unsupported platform for uv setup: ${platform}`);
  }

  async function runUpdateShell(): Promise<void> {
    try {
      await execCommand("uv", ["tool", "update-shell"]);
    } catch {
      process.stderr.write(
        "uv installed, but `uv tool update-shell` could not be run automatically\n",
      );
    }
  }

  return {
    id: "uv",
    kind: "packageManager",
    label: "uv",
    description: "Python package manager, installed only for capabilities that need it (Graphify).",
    defaultSelected: false,
    selectable: false,
    language: "python",
    // Derived from the capabilities that install through uv. A `uv` entry in
    // `packageManagers` is a leftover from when uv was required for every
    // companion and carries no choice, so it neither enables nor requires uv.
    isEnabled: (config) => isUvNeeded(config),
    gitignoreEntries: () => UV_GITIGNORE_ENTRIES,
    getInstallRequirements: ({ config }): InstallRequirement[] => {
      const plan = installPlan();
      return [
        {
          id: "core:uv",
          label: "uv package manager",
          group: "companion",
          source: "Graphify capability",
          // Installed exactly when a capability that needs it is.
          recommendedBy: UV_DEPENDENT_CAPABILITIES.filter((id) =>
            (config.capabilities ?? []).some((capability) => capability.name === id),
          ),
          command: plan.command,
          fingerprint: `uv:${platform}:${plan.command}`,
          detect: locateUv,
          install: async () => {
            await plan.install();
            if (locateUv()) await runUpdateShell();
          },
          verify: locateUv,
        },
      ];
    },
    async apply(ctx: SetupContext) {
      if (locateUv()) {
        return;
      }
      const pathValue = currentPath();

      if (ctx.mode !== "setup") {
        return;
      }
      const needing = UV_DEPENDENT_CAPABILITIES.filter((id) =>
        (ctx.config.capabilities ?? []).some((capability) => capability.name === id),
      );
      if (await isDeclinedByMember(ctx.companionPath, needing, deps.readMemberChoices)) return;

      let installCmd: string;
      let runInstall: () => Promise<void>;

      if (platform === "darwin" && onPath("brew", pathValue)) {
        installCmd = "brew install uv";
        runInstall = () => execCommand("brew", ["install", "uv"]);
      } else if (platform === "win32") {
        installCmd = `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`;
        runInstall = () =>
          execCommand("powershell", [
            "-ExecutionPolicy",
            "ByPass",
            "-c",
            "irm https://astral.sh/uv/install.ps1 | iex",
          ]);
      } else if (platform === "linux" || platform === "darwin") {
        installCmd = "curl -LsSf https://astral.sh/uv/install.sh | sh";
        runInstall = () => execShellCommand("curl -LsSf https://astral.sh/uv/install.sh | sh");
      } else {
        throw new Error(`Unsupported platform for uv setup: ${platform}`);
      }

      process.stdout.write(`uv is not installed. To install:\n  ${installCmd}\n`);
      const ok = await askConfirm("Run this install command now?");
      if (ok) {
        await runInstall();
        await runUpdateShell();
      }
    },
    async teardown(_ctx: SetupContext) {},
  };
}
