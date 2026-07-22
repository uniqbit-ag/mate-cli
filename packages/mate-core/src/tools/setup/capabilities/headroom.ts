import type { CapabilityPlugin, SetupContext } from "../plugin";
import type { InstallRequirement } from "../install-contract";
import { isCommandOnPath, runShellCommand, runShellCommandSilently } from "../utils";
import { confirm } from "../../../cli/confirm";
import { isInstalledViaUvTool } from "../package-managers/uv";

const HEADROOM_GITIGNORE_ENTRIES = ["# headroom", ".headroom/"];

const HEADROOM_INSTALL_CMD = `uv tool install --python ">=3.13" "headroom-ai[all]"`;

const RTK_INSTALL_CMD_BREW = "brew install rtk-ai/tap/rtk";
const RTK_INSTALL_CMD_FALLBACK = "curl -fsSL https://rtk.ai/install | bash";

function defaultIsRtkOnPath(): boolean {
  const pathValue = process.env.PATH ?? "";
  return isCommandOnPath("rtk", pathValue);
}

function defaultIsBrewAvailable(): boolean {
  const pathValue = process.env.PATH ?? "";
  return isCommandOnPath("brew", pathValue);
}

const RTK_INIT_COMMANDS: Record<string, string> = {
  claude: "rtk init -g --auto-patch",
  opencode: "rtk init -g --opencode --auto-patch",
};

const RTK_UNINSTALL_COMMANDS: Record<string, string> = {
  claude: "rtk init -g --uninstall",
  opencode: "rtk init -g --uninstall --opencode",
};

type HeadroomDeps = {
  confirm?: typeof confirm;
  isCommandOnPath?: typeof isCommandOnPath;
  isInstalledViaUvTool?: (pkgName: string) => boolean;
  isRtkOnPath?: () => boolean;
  isBrewAvailable?: () => boolean;
  runRtkInstallCmd?: (cmd: string) => Promise<void>;
  runShellCommandSilently?: (cmd: string) => Promise<void>;
};

export function createHeadroomPlugin(deps: HeadroomDeps = {}): CapabilityPlugin {
  const askConfirm = deps.confirm ?? confirm;
  const checkPath = deps.isCommandOnPath ?? isCommandOnPath;
  const checkUvTool = deps.isInstalledViaUvTool ?? isInstalledViaUvTool;
  const checkRtkPath = deps.isRtkOnPath ?? defaultIsRtkOnPath;
  const checkBrew = deps.isBrewAvailable ?? defaultIsBrewAvailable;
  const runRtkInstall = deps.runRtkInstallCmd ?? runShellCommand;
  const runSilently = deps.runRtkInstallCmd ?? runShellCommandSilently;

  const hasOtherActiveRtkProvider = (
    currentProviderId: string,
    activeProviders: string[],
  ): boolean =>
    Object.keys(RTK_INIT_COMMANDS).some(
      (pid) => pid !== currentProviderId && activeProviders.includes(pid),
    );

  return {
    id: "headroom",
    kind: "capability",
    label: "Headroom",
    description: "Wrap supported agent launches through Headroom when the binary is installed.",
    defaultSelected: false,
    isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === "headroom"),
    gitignoreEntries: () => HEADROOM_GITIGNORE_ENTRIES,
    getInstallRequirements: (): InstallRequirement[] => [
      {
        id: "capability:headroom",
        label: "Headroom CLI",
        group: "companion",
        source: "Headroom capability",
        command: HEADROOM_INSTALL_CMD,
        fingerprint: `headroom:${HEADROOM_INSTALL_CMD}`,
        detect: () => checkPath("headroom", process.env.PATH ?? "") || checkUvTool("headroom-ai"),
        install: () => runShellCommand(HEADROOM_INSTALL_CMD),
        verify: () => checkPath("headroom", process.env.PATH ?? "") || checkUvTool("headroom-ai"),
      },
      {
        id: "capability:rtk",
        label: "RTK CLI",
        group: "companion",
        source: "Headroom capability",
        command: checkBrew() ? RTK_INSTALL_CMD_BREW : RTK_INSTALL_CMD_FALLBACK,
        fingerprint: `rtk:${checkBrew() ? RTK_INSTALL_CMD_BREW : RTK_INSTALL_CMD_FALLBACK}`,
        detect: checkRtkPath,
        install: () => runRtkInstall(checkBrew() ? RTK_INSTALL_CMD_BREW : RTK_INSTALL_CMD_FALLBACK),
        verify: checkRtkPath,
      },
    ],
    async apply(ctx) {
      const pathValue = process.env.PATH ?? "";
      let isHeadroomInstalled = checkPath("headroom", pathValue) || checkUvTool("headroom-ai");

      if (!isHeadroomInstalled && ctx.mode === "setup") {
        process.stdout.write(`headroom binary not found. To install:\n  ${HEADROOM_INSTALL_CMD}\n`);
        const ok = await askConfirm("Run this install command now?");
        if (ok) {
          await runShellCommand(HEADROOM_INSTALL_CMD);
          isHeadroomInstalled = true;
        }
      }

      if (!isHeadroomInstalled) {
        return;
      }

      let isRtkInstalled = checkRtkPath();
      if (!isRtkInstalled && ctx.mode === "setup") {
        const useBrew = checkBrew();
        const rtkCmd = useBrew ? RTK_INSTALL_CMD_BREW : RTK_INSTALL_CMD_FALLBACK;
        process.stdout.write(`rtk binary not found. To install:\n  ${rtkCmd}\n`);
        const ok = await askConfirm("Run this install command now?");
        if (ok) {
          await runRtkInstall(rtkCmd);
          isRtkInstalled = true;
        }
      }
    },
    async teardown(_ctx) {},
    forProvider: {
      claude: {
        async apply(ctx: SetupContext) {
          if (checkRtkPath()) {
            const exec = ctx.mode === "sync" ? runSilently : runRtkInstall;
            await exec(RTK_INIT_COMMANDS.claude);
          }
        },
        async teardown(ctx: SetupContext) {
          if (checkRtkPath() && !hasOtherActiveRtkProvider("claude", ctx.activeProviders)) {
            await runRtkInstall(RTK_UNINSTALL_COMMANDS.claude);
          }
        },
      },
      opencode: {
        async apply(ctx: SetupContext) {
          if (checkRtkPath()) {
            const exec = ctx.mode === "sync" ? runSilently : runRtkInstall;
            await exec(RTK_INIT_COMMANDS.opencode);
          }
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
