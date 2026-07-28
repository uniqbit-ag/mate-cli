import { getActiveDistribution } from "../distribution";
import { frameworkCommandName } from "../framework";
import {
  enforceUpdateIfRequired,
  scheduleBackgroundCheck,
  showUpdateBannerIfAvailable,
  UpdateStateStore,
} from "../lib/update-checker";
import { runArtifactCommand } from "./commands/artifact/artifact";
import { runCapCommand } from "./commands/cap";
import { runCompanionCommand } from "./commands/companion/companion";
import { runConfigCommand } from "./commands/config";
import { runDoctorCommand } from "./commands/doctor";
import { runLaunchClaudeCommand } from "./commands/launch/claude";
import { runLaunchOpenCodeCommand } from "./commands/launch/opencode";
import { runReportCommand } from "./commands/report";
import { runUpdateCommand } from "./commands/update";
import { runInstallCommand } from "./commands/install";
import { inspectInstallPreflight } from "../lib/install";
import { ensureUnambiguousCompanion } from "./commands/shared/companion-selection";
import { hydrateDynamicPlugins } from "../tools/setup/dynamic-plugins/hydrate";
import { findPluginCliCommand } from "./plugin-commands";
import { usage } from "./usage";

export function isInstallRecoveryCommand(command?: string, subcommand?: string): boolean {
  return (
    command === "install" ||
    command === "update" ||
    command === "doctor" ||
    command === "help" ||
    command === "--help" ||
    command === "-h" ||
    (command === "companion" && (subcommand === "setup" || subcommand === "link"))
  );
}

export interface MainDeps {
  ensureUnambiguousCompanion: typeof ensureUnambiguousCompanion;
  inspectInstallPreflight: typeof inspectInstallPreflight;
  hydrateDynamicPlugins: typeof hydrateDynamicPlugins;
}

const mainDeps: MainDeps = {
  ensureUnambiguousCompanion,
  inspectInstallPreflight,
  hydrateDynamicPlugins,
};

export async function main(argv = process.argv, deps: MainDeps = mainDeps): Promise<void> {
  const [, , command, subcommand, ...rest] = argv;

  if (command === "-v" || command === "--version") {
    console.log(getActiveDistribution().config.version);
    return;
  }

  // Companion-declared plugins register before cap-command detection so
  // their commands route like compiled-in ones (including MCP servers whose
  // command is their own cap subcommand). Diagnostics stay on stderr; a
  // missing or ambiguous companion makes this a no-op.
  await deps.hydrateDynamicPlugins();

  // Plugin commands (`mate cap <namespace> <command>`) own their stdout (an
  // MCP server speaks JSON-RPC over it), so banners and background chatter
  // are suppressed for them.
  const isPluginCommand =
    command === "cap" && findPluginCliCommand(subcommand, rest[0]) !== undefined;
  if (!isPluginCommand) {
    const updateStore = new UpdateStateStore();
    scheduleBackgroundCheck(updateStore);
    if (
      !isInstallRecoveryCommand(command, subcommand) &&
      (await enforceUpdateIfRequired(updateStore))
    ) {
      process.exitCode = 1;
      return;
    }
    await showUpdateBannerIfAvailable(updateStore);
  }

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  if (!(await deps.ensureUnambiguousCompanion())) {
    process.exitCode = 1;
    return;
  }

  if (!isInstallRecoveryCommand(command, subcommand)) {
    const preflight = await deps.inspectInstallPreflight();
    if (!preflight.ok) {
      console.error(
        `${frameworkCommandName()}: ${preflight.reason ?? "installation is incomplete"}`,
      );
      console.error(`Run \`${frameworkCommandName()} install\` before continuing.`);
      process.exitCode = 1;
      return;
    }
  }

  switch (command) {
    case "install":
      await runInstallCommand(argv.slice(3));
      return;
    case "artifact":
      await runArtifactCommand(subcommand, rest);
      return;
    case "companion":
      await runCompanionCommand(subcommand, rest);
      return;
    case "claude":
      await runLaunchClaudeCommand(argv.slice(3), { directPassthrough: true });
      return;
    case "opencode":
      await runLaunchOpenCodeCommand(argv.slice(3), { directPassthrough: true });
      return;
    case "report":
      await runReportCommand(argv.slice(3));
      return;
    case "config":
      await runConfigCommand(argv.slice(3));
      return;
    case "doctor":
      await runDoctorCommand(argv.slice(3));
      return;
    case "cap":
      await runCapCommand(subcommand, rest);
      return;
    case "update":
      await runUpdateCommand(argv.slice(3));
      return;
    default:
      console.error(`Unknown command: ${command}`);
      console.error(usage());
      process.exitCode = 1;
  }
}
