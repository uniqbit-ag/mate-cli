import type { CapabilityPlugin, SetupContext } from "../plugin";
import type { InstallRequirement } from "../install-contract";
import { isCommandOnPath, runShellCommand, runShellCommandSilently } from "../utils";
import { confirm } from "../../../cli/confirm";

export const RTK_INSTALL_CMD_BREW = "brew install rtk-ai/tap/rtk";
export const RTK_INSTALL_CMD_FALLBACK =
  "curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh";

const RTK_INIT_COMMANDS: Record<string, string> = {
  claude: "rtk init -g --auto-patch",
  opencode: "rtk init -g --opencode --auto-patch",
  pi: "rtk init -g --agent pi --auto-patch",
};

const RTK_UNINSTALL_COMMANDS: Record<string, string> = {
  claude: "rtk init -g --uninstall",
  opencode: "rtk init -g --uninstall --opencode",
  pi: "rtk init -g --agent pi --uninstall",
};

function defaultIsRtkOnPath(): boolean {
  return isCommandOnPath("rtk", process.env.PATH ?? "");
}

function defaultIsBrewAvailable(): boolean {
  return isCommandOnPath("brew", process.env.PATH ?? "");
}

export type RtkDeps = {
  confirm?: typeof confirm;
  isRtkOnPath?: () => boolean;
  isBrewAvailable?: () => boolean;
  runRtkInstallCmd?: (cmd: string) => Promise<void>;
  runRtkCommandSilently?: (cmd: string) => Promise<void>;
};

export function createRtkPlugin(deps: RtkDeps = {}): CapabilityPlugin {
  const askConfirm = deps.confirm ?? confirm;
  const checkRtkPath = deps.isRtkOnPath ?? defaultIsRtkOnPath;
  const checkBrew = deps.isBrewAvailable ?? defaultIsBrewAvailable;
  const runRtkInstall = deps.runRtkInstallCmd ?? runShellCommand;
  const runSilently = deps.runRtkCommandSilently ?? runShellCommandSilently;
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
    getInstallRequirements: (): InstallRequirement[] => {
      const command = checkBrew() ? RTK_INSTALL_CMD_BREW : RTK_INSTALL_CMD_FALLBACK;
      return [
        {
          id: "capability:rtk",
          label: "RTK CLI",
          group: "companion",
          source: "RTK capability",
          command,
          fingerprint: `rtk:${command}`,
          detect: checkRtkPath,
          install: () => runRtkInstall(command),
          verify: checkRtkPath,
        },
      ];
    },
    async apply(ctx) {
      if (checkRtkPath() || ctx.mode !== "setup") return;

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
      pi: {
        async apply(ctx: SetupContext) {
          if (!checkRtkPath()) return;
          const run = ctx.mode === "sync" ? runSilently : runRtkInstall;
          await run(RTK_INIT_COMMANDS.pi);
        },
        async teardown(ctx: SetupContext) {
          if (checkRtkPath() && !hasOtherActiveRtkProvider("pi", ctx.activeProviders)) {
            await runRtkInstall(RTK_UNINSTALL_COMMANDS.pi);
          }
        },
      },
    },
  };
}
