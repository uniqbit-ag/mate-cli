import os from "node:os";
import path from "node:path";

import type { CapabilityPlugin, RuntimeContributionsByRuntime, SetupContext } from "../plugin";
import type { InstallRequirement } from "../install-contract";
import { hasRtkCapability } from "../../../runtime/companion-guidance";
import {
  installedVersionOutput,
  isCommandOnPath,
  resolveCommandOnPath,
  runShellCommand,
  runShellCommandSilently,
} from "../utils";
import { confirm } from "../../../cli/confirm";
import { isDeclinedByMember, type ReadMemberChoices } from "../../../lib/member-choices";
import { toolVersion, warnOnVersionDrift } from "../../../lib/tool-manifest";

const RTK_VERSION = toolVersion("rtk");
// The release's installer with RTK_VERSION installs that release and checks its checksum;
// Homebrew would install the latest formula instead.
const RTK_INSTALL_CMD = `curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/v${RTK_VERSION}/install.sh | RTK_VERSION=v${RTK_VERSION} sh`;

const RTK_INIT_COMMANDS: Record<string, string> = {
  claude: "rtk init -g --auto-patch",
  opencode: "rtk init -g --opencode --auto-patch",
};

const RTK_UNINSTALL_COMMANDS: Record<string, string> = {
  claude: "rtk init -g --uninstall",
  opencode: "rtk init -g --uninstall --opencode",
};

/** Where the pinned installer puts `rtk`; it only prints a PATH hint, so a fresh install may be off PATH. */
function rtkInstallDir(): string {
  return process.env.RTK_INSTALL_DIR || path.join(os.homedir(), ".local", "bin");
}

/**
 * True when `rtk` is on PATH or in its install directory; the latter is appended to this
 * process's PATH, last, so its other binaries never shadow the member's.
 */
function locateRtk(installDir: string): boolean {
  if (isCommandOnPath("rtk", process.env.PATH ?? "")) return true;
  if (!isCommandOnPath("rtk", installDir)) return false;
  process.env.PATH = [process.env.PATH, installDir].filter(Boolean).join(path.delimiter);
  return true;
}

/** The first `rtk` on PATH, as PATH names it. */
function defaultRtkBinaryPath(): string | null {
  return resolveCommandOnPath("rtk", process.env.PATH ?? "") ?? null;
}

export type RtkDeps = {
  confirm?: typeof confirm;
  isRtkOnPath?: () => boolean;
  /** Probed when `rtk` is not on PATH; defaults to the installer's target. */
  installDir?: string;
  runRtkInstallCmd?: (cmd: string) => Promise<void>;
  runRtkCommandSilently?: (cmd: string) => Promise<void>;
  readMemberChoices?: ReadMemberChoices;
  rtkBinaryPath?: () => string | null;
  installedRtkVersion?: (binary: string) => Promise<string | null>;
};

/**
 * Whether this setup run ends the provider's RTK use. The uninstall edits the member's
 * global agent config, which other companions rely on, so only such a transition may run it.
 */
function endsRtkUse(providerId: string, ctx: SetupContext): boolean {
  const previous = ctx.previousSetup;
  if (!previous || !hasRtkCapability(previous.config.capabilities)) return false;
  if (!previous.activeProviders.includes(providerId)) return false;
  const otherProviderStays =
    hasRtkCapability(ctx.config.capabilities) &&
    Object.keys(RTK_INIT_COMMANDS).some(
      (id) => id !== providerId && ctx.activeProviders.includes(id),
    );
  return !otherProviderStays;
}

export function createRtkPlugin(deps: RtkDeps = {}): CapabilityPlugin {
  const askConfirm = deps.confirm ?? confirm;
  const checkRtkPath = deps.isRtkOnPath ?? (() => locateRtk(deps.installDir ?? rtkInstallDir()));
  const runRtkInstall = deps.runRtkInstallCmd ?? runShellCommand;
  const runSilently = deps.runRtkCommandSilently ?? runShellCommandSilently;
  const checkRtkVersion = async (): Promise<void> => {
    const binary = (deps.rtkBinaryPath ?? defaultRtkBinaryPath)();
    if (!binary) return;
    const installed = await (deps.installedRtkVersion ?? installedVersionOutput)(binary);
    warnOnVersionDrift("rtk", installed, RTK_INSTALL_CMD, binary);
  };

  return {
    id: "rtk",
    kind: "capability",
    label: "RTK",
    description: "Patch supported agent providers with RTK when selected.",
    defaultSelected: false,
    isEnabled: (config) => hasRtkCapability(config.capabilities),
    getRuntimeContributions(): RuntimeContributionsByRuntime {
      return { claude: { permissionEntries: ["Bash(rtk:*)"] } };
    },
    getInstallRequirements: (): InstallRequirement[] => {
      const command = RTK_INSTALL_CMD;
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
          update: checkRtkVersion,
        },
      ];
    },
    lifecycle: {
      companion: {
        async apply(ctx) {
          if (checkRtkPath() || ctx.mode !== "setup") return;
          if (await isDeclinedByMember(ctx.companionPath, ["rtk"], deps.readMemberChoices)) return;

          const command = RTK_INSTALL_CMD;
          process.stdout.write(`rtk binary not found. To install:\n  ${command}\n`);
          if (await askConfirm("Run this install command now?")) {
            await runRtkInstall(command);
          }
        },
        async teardown(_ctx) {},
      },
    },
    forProvider: {
      claude: {
        async apply(ctx: SetupContext) {
          if (!checkRtkPath()) return;
          const run = ctx.mode === "sync" ? runSilently : runRtkInstall;
          await run(RTK_INIT_COMMANDS.claude);
        },
        async teardown(ctx: SetupContext) {
          if (endsRtkUse("claude", ctx) && checkRtkPath()) {
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
          if (endsRtkUse("opencode", ctx) && checkRtkPath()) {
            await runRtkInstall(RTK_UNINSTALL_COMMANDS.opencode);
          }
        },
      },
    },
  };
}
