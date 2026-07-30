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
import { runLaunchCodexCommand } from "./commands/launch/codex";
import { runLaunchOpenCodeCommand } from "./commands/launch/opencode";
import { runReportCommand } from "./commands/report";
import { runUpdateCommand } from "./commands/update";
import { runInstallCommand } from "./commands/install";
import { inspectInstallPreflight } from "../lib/install";
import { ensureUnambiguousCompanion } from "./commands/shared/companion-selection";
import { hydrateDynamicPlugins } from "../tools/setup/dynamic-plugins/hydrate";
import { findPluginCliCommand } from "./plugin-commands";
import { usage } from "./usage";

export interface GateNeeds {
  /** Block the command while an enforced update is pending. */
  updateGuard?: boolean;
  /** Require an unambiguous companion (selection wizard on ambiguity) before dispatch. */
  companion?: boolean;
  /** Require a complete installation (install preflight) before dispatch. */
  install?: boolean;
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

  // Companion-declared plugins register before cap-command detection and
  // before help text is printed, so their commands route like compiled-in
  // ones (including MCP servers whose command is their own cap subcommand)
  // and show up in `mate help`. Diagnostics stay on stderr; a missing or
  // ambiguous companion makes this a no-op.
  await deps.hydrateDynamicPlugins();

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  // Plugin commands (`mate cap <namespace> <command>`) own their stdout (an
  // MCP server speaks JSON-RPC over it), so banners and background chatter
  // are suppressed for them.
  const isPluginCommand =
    command === "cap" && findPluginCliCommand(subcommand, rest[0]) !== undefined;

  // Every dispatch case opens with a gate() call declaring what the command
  // needs before it may run. Declared gates run in fixed order — update
  // enforcement, companion selection, install preflight — and a blocked gate
  // sets the exit code, so callers only need `if (!(await gate(...))) return`.
  const gate = async (needs: GateNeeds): Promise<boolean> => {
    if (!isPluginCommand) {
      const updateStore = new UpdateStateStore();
      scheduleBackgroundCheck(updateStore);
      if (needs.updateGuard && (await enforceUpdateIfRequired(updateStore))) {
        process.exitCode = 1;
        return false;
      }
      await showUpdateBannerIfAvailable(updateStore);
    }

    if (needs.companion && !(await deps.ensureUnambiguousCompanion())) {
      process.exitCode = 1;
      return false;
    }

    if (needs.install) {
      const preflight = await deps.inspectInstallPreflight();
      if (!preflight.ok) {
        console.error(
          `${frameworkCommandName()}: ${preflight.reason ?? "installation is incomplete"}`,
        );
        console.error(`Run \`${frameworkCommandName()} install\` before continuing.`);
        process.exitCode = 1;
        return false;
      }
    }

    return true;
  };

  switch (command) {
    case "install":
      // Builds a companion-scoped context, so it needs an unambiguous
      // companion — but must stay runnable when installation is incomplete.
      if (!(await gate({ companion: true }))) return;
      await runInstallCommand(argv.slice(3));
      return;
    case "artifact":
      if (!(await gate({ updateGuard: true, companion: true, install: true }))) return;
      await runArtifactCommand(subcommand, rest);
      return;
    case "companion":
      switch (subcommand) {
        // setup/link are recovery paths and must never be gated on the
        // state they exist to repair.
        case "setup":
        case "link":
          if (!(await gate({}))) return;
          break;
        // open/tui consume a companion context.
        case "open":
        case "tui":
          if (!(await gate({ updateGuard: true, companion: true }))) return;
          break;
        // list and unknown subcommands (which fail inside the command).
        default:
          if (!(await gate({ updateGuard: true }))) return;
      }
      await runCompanionCommand(subcommand, rest);
      return;
    case "claude":
      if (!(await gate({ updateGuard: true, companion: true, install: true }))) return;
      await runLaunchClaudeCommand(argv.slice(3), { directPassthrough: true });
      return;
    case "codex":
      await runLaunchCodexCommand(argv.slice(3), { directPassthrough: true });
      return;
    case "opencode":
      if (!(await gate({ updateGuard: true, companion: true, install: true }))) return;
      await runLaunchOpenCodeCommand(argv.slice(3), { directPassthrough: true });
      return;
    case "report":
      if (!(await gate({ updateGuard: true, install: true }))) return;
      await runReportCommand(argv.slice(3));
      return;
    case "config":
      if (!(await gate({ updateGuard: true }))) return;
      await runConfigCommand(argv.slice(3));
      return;
    case "doctor":
      if (!(await gate({}))) return;
      await runDoctorCommand(argv.slice(3));
      return;
    case "cap":
      if (!(await gate({ updateGuard: true, companion: true, install: true }))) return;
      await runCapCommand(subcommand, rest);
      return;
    case "update":
      if (!(await gate({}))) return;
      await runUpdateCommand(argv.slice(3));
      return;
    default:
      // Unknown commands fail fast: no case matched, so no gate ever ran.
      console.error(`Unknown command: ${command}`);
      console.error(usage());
      process.exitCode = 1;
  }
}
