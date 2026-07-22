import type { Plugin, SetupContext } from "../plugin";
import type { InstallRequirement } from "../install-contract";
import { confirm } from "../../../cli/confirm";
import { isCommandOnPath, runCommand, runShellCommand } from "../utils";

export interface PackageManagerSetupDeps {
  confirm?: typeof confirm;
  isCommandOnPath?: (command: string, pathValue: string) => boolean;
  pathValue?: string;
  platform?: NodeJS.Platform;
  runCommand?: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
  runShellCommand?: (command: string, options?: { cwd?: string }) => Promise<void>;
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
    description: "Python package manager project bootstrap companion capabilities.",
    defaultSelected: false,
    language: "python",
    isEnabled: (config) => (config.packageManagers ?? ["bun"]).includes("uv"),
    gitignoreEntries: () => UV_GITIGNORE_ENTRIES,
    getInstallRequirements: (): InstallRequirement[] => {
      const plan = installPlan();
      const pathValue = deps.pathValue ?? process.env.PATH ?? "";
      return [
        {
          id: "core:uv",
          label: "uv package manager",
          group: "core",
          source: "Mate package manager",
          command: plan.command,
          fingerprint: `uv:${platform}:${plan.command}`,
          detect: () => onPath("uv", pathValue),
          install: async () => {
            await plan.install();
            await runUpdateShell();
          },
          verify: () => onPath("uv", deps.pathValue ?? process.env.PATH ?? ""),
        },
      ];
    },
    async apply(ctx: SetupContext) {
      const pathValue = deps.pathValue ?? process.env.PATH ?? "";
      if (onPath("uv", pathValue)) {
        return;
      }

      if (ctx.mode !== "setup") {
        return;
      }

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
