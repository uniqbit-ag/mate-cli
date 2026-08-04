import { getActiveDistribution } from "../distribution";
import { FRAMEWORK_NAME } from "../framework";
import {
  enforceUpdateIfRequired,
  scheduleBackgroundCheck,
  showUpdateBannerIfAvailable,
  UpdateStateStore,
} from "../lib/update-checker";
import { runArtifactCommand } from "./commands/artifact/artifact";
import { runCapCommand } from "./commands/cap";
import { runCompanionCommand } from "./commands/companion/companion";
import { runHubCommand } from "./commands/companion/hub";
import { runConfigCommand } from "./commands/config";
import { runDoctorCommand } from "./commands/doctor";
import { runLaunchClaudeCommand } from "./commands/launch/claude";
import { runLaunchOpenCodeCommand } from "./commands/launch/opencode";
import { runPluginCommand } from "./commands/plugin/plugin";
import { runReportCommand } from "./commands/report";
import { runUpdateCommand } from "./commands/update";
import { runInstallCommand } from "./commands/install";
import { inspectInstallPreflight } from "../lib/install";
import { resolveRootContext } from "../lib/orchestrator/root-context";
import { ensureUnambiguousCompanion } from "./commands/shared/companion-selection";
import { hydrateDynamicPlugins } from "../tools/setup/dynamic-plugins/hydrate";
import { findPluginCliCommand } from "./plugin-commands";
import { usage } from "./usage";

export interface GateNeeds {
  /** Block the command while an enforced update is pending. */
  updateGuard?: boolean;
  /** Block the command when the current directory resolves to a hub root. */
  notHubRoot?: boolean;
  /** Require an unambiguous companion (selection wizard on ambiguity) before dispatch. */
  companion?: boolean;
  /** Require a complete installation (install preflight) before dispatch. */
  install?: boolean;
}

export interface MainDeps {
  ensureUnambiguousCompanion: typeof ensureUnambiguousCompanion;
  inspectInstallPreflight: typeof inspectInstallPreflight;
  hydrateDynamicPlugins: typeof hydrateDynamicPlugins;
  resolveRootContext: typeof resolveRootContext;
}

const mainDeps: MainDeps = {
  ensureUnambiguousCompanion,
  inspectInstallPreflight,
  hydrateDynamicPlugins,
  resolveRootContext,
};

export async function main(argv = process.argv, deps: MainDeps = mainDeps): Promise<void> {
  const [, , command, subcommand, ...rest] = argv;

  if (command === "-v" || command === "--version") {
    console.log(getActiveDistribution().config.version);
    return;
  }

  // Dynamic plugins register before cap-command detection and before help
  // text is printed, so their commands route like compiled-in ones
  // (including MCP servers whose command is their own cap subcommand) and
  // show up in `mate help`. Diagnostics stay on stderr; a missing or
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

    if (needs.notHubRoot && (await deps.resolveRootContext()).kind === "hub") {
      console.error(
        `${FRAMEWORK_NAME}: this directory resolves to a companion hub root; companion commands are not available here. Use \`${FRAMEWORK_NAME} hub ...\` to manage the hub.`,
      );
      process.exitCode = 1;
      return false;
    }

    if (needs.companion && !(await deps.ensureUnambiguousCompanion())) {
      process.exitCode = 1;
      return false;
    }

    if (needs.install) {
      const preflight = await deps.inspectInstallPreflight();
      if (!preflight.ok) {
        console.error(`${FRAMEWORK_NAME}: ${preflight.reason ?? "installation is incomplete"}`);
        console.error(`Run \`${FRAMEWORK_NAME} install\` before continuing.`);
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
    case "plugin":
      // Declares into framework.yaml and installs on the spot, so it needs
      // the same gating as `install` — an unambiguous companion, but must
      // stay runnable when installation is otherwise incomplete.
      if (!(await gate({ updateGuard: true }))) return;
      await runPluginCommand(subcommand, rest);
      return;
    case "artifact":
      if (!(await gate({ updateGuard: true, companion: true, install: true }))) return;
      await runArtifactCommand(subcommand, rest);
      return;
    case "companion":
      switch (subcommand) {
        // setup/link are recovery paths and must never be gated on the
        // state they exist to repair — but hubs are never companions.
        case "setup":
        case "link":
          if (!(await gate({ notHubRoot: true }))) return;
          break;
        // Hub commands establish and operate on a local hub root directly;
        // they must not require a linked working repository or installation.
        case "hub":
          if (!(await gate({ updateGuard: true }))) return;
          break;
        // open/tui consume a companion context.
        case "open":
        case "tui":
          if (!(await gate({ updateGuard: true, notHubRoot: true, companion: true }))) return;
          break;
        // list and unknown subcommands (which fail inside the command).
        default:
          if (!(await gate({ updateGuard: true, notHubRoot: true }))) return;
      }
      await runCompanionCommand(subcommand, rest);
      return;
    case "hub":
      if (!(await gate({ updateGuard: true }))) return;
      await runHubCommand(subcommand ? [subcommand, ...rest] : []);
      return;
    case "claude":
      if (!(await gate({ updateGuard: true, companion: true, install: true }))) return;
      await runLaunchClaudeCommand(argv.slice(3), { directPassthrough: true });
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
