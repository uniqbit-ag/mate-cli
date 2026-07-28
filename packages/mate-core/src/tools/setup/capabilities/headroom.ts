import type { CapabilityPlugin } from "../plugin";
import type { InstallRequirement } from "../install-contract";
import { isCommandOnPath, runShellCommand } from "../utils";
import { confirm } from "../../../cli/confirm";
import { isInstalledViaUvTool } from "../package-managers/uv";

const HEADROOM_GITIGNORE_ENTRIES = ["# headroom", ".headroom/"];

const HEADROOM_INSTALL_CMD = `uv tool install --python ">=3.13" "headroom-ai[all]"`;

type HeadroomDeps = {
  confirm?: typeof confirm;
  isCommandOnPath?: typeof isCommandOnPath;
  isInstalledViaUvTool?: (pkgName: string) => boolean;
};

export function createHeadroomPlugin(deps: HeadroomDeps = {}): CapabilityPlugin {
  const askConfirm = deps.confirm ?? confirm;
  const checkPath = deps.isCommandOnPath ?? isCommandOnPath;
  const checkUvTool = deps.isInstalledViaUvTool ?? isInstalledViaUvTool;

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
    ],
    async apply(ctx) {
      const pathValue = process.env.PATH ?? "";
      const isHeadroomInstalled = checkPath("headroom", pathValue) || checkUvTool("headroom-ai");

      if (!isHeadroomInstalled && ctx.mode === "setup") {
        process.stdout.write(`headroom binary not found. To install:\n  ${HEADROOM_INSTALL_CMD}\n`);
        const ok = await askConfirm("Run this install command now?");
        if (ok) {
          await runShellCommand(HEADROOM_INSTALL_CMD);
        }
      }
    },
    async teardown(_ctx) {},
  };
}
