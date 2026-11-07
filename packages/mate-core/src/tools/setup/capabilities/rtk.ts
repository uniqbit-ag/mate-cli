import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CapabilityPlugin, RuntimeContributionsByRuntime, SetupContext } from "../plugin";
import type { InstallRequirement } from "../install-contract";
import {
  isCommandOnPath,
  resolveCommandOnPath,
  runShellCommand,
  runShellCommandSilently,
} from "../utils";
import { confirm } from "../../../cli/confirm";
import { errorMessage } from "../../../runtime/error-message";
import { isDeclinedByMember, type ReadMemberChoices } from "../../../lib/member-choices";

const RTK_INSTALL_CMD_BREW = "brew install rtk-ai/tap/rtk";
const RTK_INSTALL_CMD_FALLBACK =
  "curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh";

const RTK_INIT_COMMANDS: Record<string, string> = {
  claude: "rtk init -g --auto-patch",
  opencode: "rtk init -g --opencode --auto-patch",
};

const RTK_UNINSTALL_COMMANDS: Record<string, string> = {
  claude: "rtk init -g --uninstall",
  opencode: "rtk init -g --uninstall --opencode",
};

function defaultIsRtkOnPath(): boolean {
  return isCommandOnPath("rtk", process.env.PATH ?? "");
}

function defaultIsBrewAvailable(): boolean {
  return isCommandOnPath("brew", process.env.PATH ?? "");
}

/**
 * The Homebrew formula `binary` comes from (`rtk` or `<tap>/rtk`), read from its keg's
 * install receipt; null when it is no Homebrew keg.
 */
function defaultBrewFormulaOf(binary: string): string | null {
  // <prefix>/Cellar/rtk/<version>/bin/rtk
  const keg = path.dirname(path.dirname(fs.realpathSync(binary)));
  const formulaDir = path.dirname(keg);
  if (path.basename(formulaDir) !== "rtk" || path.basename(path.dirname(formulaDir)) !== "Cellar") {
    return null;
  }
  let tap: unknown;
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(keg, "INSTALL_RECEIPT.json"), "utf8"));
    tap = receipt?.source?.tap;
  } catch {
    // no readable receipt: the formula's bare name
  }
  return typeof tap === "string" && tap !== "homebrew/core" ? `${tap}/rtk` : "rtk";
}

/** The latest release tag, from the `/releases/latest` redirect GitHub answers without rate limit. */
async function defaultLatestRtkTag(): Promise<string | null> {
  const response = await fetch("https://github.com/rtk-ai/rtk/releases/latest", {
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  return response.headers.get("location")?.match(/\/tag\/(v[\w.-]+)$/)?.[1] ?? null;
}

/** The version `binary --version` reports (`rtk 1.1.0`), else null. */
function defaultInstalledRtkVersion(binary: string): string | null {
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });
  return result.stdout?.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? null;
}

/** The first `rtk` on PATH, as PATH names it. */
function defaultRtkBinaryPath(): string | null {
  return resolveCommandOnPath("rtk", process.env.PATH ?? "") ?? null;
}

export type RtkDeps = {
  confirm?: typeof confirm;
  isRtkOnPath?: () => boolean;
  isBrewAvailable?: () => boolean;
  runRtkInstallCmd?: (cmd: string) => Promise<void>;
  runRtkCommandSilently?: (cmd: string) => Promise<void>;
  readMemberChoices?: ReadMemberChoices;
  rtkBinaryPath?: () => string | null;
  brewFormulaOf?: (binary: string) => string | null;
  latestRtkTag?: () => Promise<string | null>;
  installedRtkVersion?: (binary: string) => string | null;
  homeDir?: () => string;
};

export function createRtkPlugin(deps: RtkDeps = {}): CapabilityPlugin {
  const askConfirm = deps.confirm ?? confirm;
  const checkRtkPath = deps.isRtkOnPath ?? defaultIsRtkOnPath;
  const checkBrew = deps.isBrewAvailable ?? defaultIsBrewAvailable;
  const runRtkInstall = deps.runRtkInstallCmd ?? runShellCommand;
  const runSilently = deps.runRtkCommandSilently ?? runShellCommandSilently;
  /**
   * The command that upgrades the `rtk` on PATH through the channel that installed it:
   * its Homebrew formula, or, for the installer's default `~/.local/bin/rtk`, the
   * installer of a newer release, pinned to its tag. Null for any other installation,
   * such as Cargo's, which is left alone.
   */
  const rtkUpgradeCommand = async (): Promise<string | null> => {
    const binary = (deps.rtkBinaryPath ?? defaultRtkBinaryPath)();
    if (!binary) return null;
    const formula = (deps.brewFormulaOf ?? defaultBrewFormulaOf)(binary);
    if (formula) return `brew upgrade ${formula}`;
    const home = (deps.homeDir ?? os.homedir)();
    if (path.resolve(binary) !== path.join(home, ".local", "bin", "rtk")) return null;
    const tag = await (deps.latestRtkTag ?? defaultLatestRtkTag)();
    const installed = (deps.installedRtkVersion ?? defaultInstalledRtkVersion)(binary);
    if (!tag || tag.replace(/^v/, "") === installed) return null;
    return `curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/${tag}/install.sh | RTK_VERSION=${tag} sh`;
  };

  /** Best-effort, as TokenSave's: a failure warns and keeps the installed version. */
  const upgradeRtk = async (): Promise<void> => {
    try {
      const command = await rtkUpgradeCommand();
      if (command) await runSilently(command);
    } catch (error) {
      process.stderr.write(
        `rtk: automatic upgrade failed: ${errorMessage(error)} - continuing with the installed version\n`,
      );
    }
  };
  const hasOtherActiveRtkProvider = (currentProviderId: string, activeProviders: string[]) =>
    Object.keys(RTK_INIT_COMMANDS).some(
      (providerId) => providerId !== currentProviderId && activeProviders.includes(providerId),
    );

  return {
    id: "rtk",
    kind: "capability",
    label: "RTK",
    description: "Patch supported agent providers with RTK when selected.",
    defaultSelected: false,
    isEnabled: (config) =>
      (config.capabilities ?? []).some((capability) => capability.name === "rtk"),
    getRuntimeContributions(): RuntimeContributionsByRuntime {
      return { claude: { permissionEntries: ["Bash(rtk:*)"] } };
    },
    getInstallRequirements: (): InstallRequirement[] => {
      const command = checkBrew() ? RTK_INSTALL_CMD_BREW : RTK_INSTALL_CMD_FALLBACK;
      return [
        {
          id: "capability:rtk",
          label: "RTK CLI",
          group: "companion",
          source: "RTK capability",
          recommendedBy: ["rtk"],
          command,
          fingerprint: `rtk:${command}`,
          detect: checkRtkPath,
          install: () => runRtkInstall(command),
          verify: checkRtkPath,
          update: upgradeRtk,
        },
      ];
    },
    async apply(ctx) {
      if (checkRtkPath() || ctx.mode !== "setup") return;
      if (await isDeclinedByMember(ctx.companionPath, ["rtk"], deps.readMemberChoices)) return;

      const command = checkBrew() ? RTK_INSTALL_CMD_BREW : RTK_INSTALL_CMD_FALLBACK;
      process.stdout.write(`rtk binary not found. To install:\n  ${command}\n`);
      if (await askConfirm("Run this install command now?")) {
        await runRtkInstall(command);
      }
    },
    async teardown(_ctx) {},
    forProvider: {
      claude: {
        async apply(ctx: SetupContext) {
          if (!checkRtkPath()) return;
          const run = ctx.mode === "sync" ? runSilently : runRtkInstall;
          await run(RTK_INIT_COMMANDS.claude);
        },
        async teardown(ctx: SetupContext) {
          if (checkRtkPath() && !hasOtherActiveRtkProvider("claude", ctx.activeProviders)) {
            await runRtkInstall(RTK_UNINSTALL_COMMANDS.claude);
          }
        },
      },
      opencode: {
        async apply(ctx: SetupContext) {
          if (!checkRtkPath()) return;
          const run = ctx.mode === "sync" ? runSilently : runRtkInstall;
          await run(RTK_INIT_COMMANDS.opencode);
        },
        async teardown(ctx: SetupContext) {
          if (checkRtkPath() && !hasOtherActiveRtkProvider("opencode", ctx.activeProviders)) {
            await runRtkInstall(RTK_UNINSTALL_COMMANDS.opencode);
          }
        },
      },
    },
  };
}
