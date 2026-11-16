import type { CapabilityPlugin, RuntimeContributionsByRuntime, SetupContext } from "../plugin";
import type { InstallRequirement } from "../install-contract";
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

function defaultIsRtkOnPath(): boolean {
  return isCommandOnPath("rtk", process.env.PATH ?? "");
}

/** The first `rtk` on PATH, as PATH names it. */
function defaultRtkBinaryPath(): string | null {
  return resolveCommandOnPath("rtk", process.env.PATH ?? "") ?? null;
}

export type RtkDeps = {
  confirm?: typeof confirm;
  isRtkOnPath?: () => boolean;
  runRtkInstallCmd?: (cmd: string) => Promise<void>;
  runRtkCommandSilently?: (cmd: string) => Promise<void>;
  readMemberChoices?: ReadMemberChoices;
  rtkBinaryPath?: () => string | null;
  installedRtkVersion?: (binary: string) => Promise<string | null>;
};

export function createRtkPlugin(deps: RtkDeps = {}): CapabilityPlugin {
  const askConfirm = deps.confirm ?? confirm;
  const checkRtkPath = deps.isRtkOnPath ?? defaultIsRtkOnPath;
  const runRtkInstall = deps.runRtkInstallCmd ?? runShellCommand;
  const runSilently = deps.runRtkCommandSilently ?? runShellCommandSilently;
  const checkRtkVersion = async (): Promise<void> => {
    const binary = (deps.rtkBinaryPath ?? defaultRtkBinaryPath)();
    if (!binary) return;
    const installed = await (deps.installedRtkVersion ?? installedVersionOutput)(binary);
    warnOnVersionDrift("rtk", installed, RTK_INSTALL_CMD);
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
