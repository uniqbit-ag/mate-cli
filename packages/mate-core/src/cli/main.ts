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
import { runWorkspaceCommand } from "./commands/workspace/workspace";
import { runUnwrapCommand } from "./commands/unwrap";
import { parseWrapArgs, runWrapCommand } from "./commands/wrap";
import { runWorkingCommand } from "./commands/working/working";
import { runInstallCommand } from "./commands/install";
import { inspectInstallPreflight } from "../lib/install";
import { resolveRootContext } from "../lib/orchestrator/root-context";
import {
  ensureUnambiguousCompanion,
  type CompanionSelectionOptions,
} from "./commands/shared/companion-selection";
import { hydrateDynamicPlugins } from "../tools/setup/dynamic-plugins/hydrate";
import { findPluginCliCommand } from "./plugin-commands";
import { usage } from "./usage";

export interface GateNeeds {
  /** Block the command while an enforced update is pending. */
  updateGuard?: boolean;
  /** Block the command when the current directory resolves to a hub root. */
  notHubRoot?: boolean;
  /** Block the command when the current directory resolves to a companion root. */
  notCompanionRoot?: boolean;
  /**
   * Require an unambiguous companion (selection wizard on ambiguity) before
   * dispatch. Options select a companion explicitly or force the wizard past a
   * recorded answer.
   */
  companion?: boolean | CompanionSelectionOptions;
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

  // `workspace list`/`workspace materialize` are machine-JSON contracts an
  // editor extension may poll frequently; their stdout must be pure JSON,
  // and the un-awaited scheduleBackgroundCheck() has been observed to race
  // a large final stdout write against process exit, truncating it. Both
  // reasons put them in the same stdout-owning bucket as plugin commands.
  const ownsStdout = isPluginCommand || command === "workspace";

  // Every dispatch case opens with a gate() call declaring what the command
  // needs before it may run. Declared gates run in fixed order — update
  // enforcement, companion selection, install preflight — and a blocked gate
  // sets the exit code, so callers only need `if (!(await gate(...))) return`.
  const gate = async (needs: GateNeeds): Promise<boolean> => {
    if (!ownsStdout) {
      const updateStore = new UpdateStateStore();
      scheduleBackgroundCheck(updateStore);
      if (needs.updateGuard && (await enforceUpdateIfRequired(updateStore))) {
        process.exitCode = 1;
        return false;
      }
      await showUpdateBannerIfAvailable(updateStore);
    }

    if (needs.notHubRoot || needs.notCompanionRoot) {
      const kind = (await deps.resolveRootContext()).kind;
      if (needs.notHubRoot && kind === "hub") {
        console.error(
          `${FRAMEWORK_NAME}: this directory resolves to a companion hub root; companion commands are not available here. Use \`${FRAMEWORK_NAME} hub ...\` to manage the hub.`,
        );
        process.exitCode = 1;
        return false;
      }
      if (needs.notCompanionRoot && kind === "companion") {
        console.error(
          `${FRAMEWORK_NAME}: this directory resolves to a companion root; hub commands are not available here. Run them from a hub root.`,
        );
        process.exitCode = 1;
        return false;
      }
    }

    const companionOptions = typeof needs.companion === "object" ? needs.companion : {};
    if (
      needs.companion &&
      !(await deps.ensureUnambiguousCompanion(process.cwd(), companionOptions))
    ) {
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
      // the same gating as `install` — an unambiguous companion (hubs pass
      // trivially), but must stay runnable when installation is otherwise
      // incomplete.
      if (!(await gate({ companion: true }))) return;
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
        // they must not require a linked working repository or installation —
        // but companions are never hubs.
        case "hub":
          if (!(await gate({ updateGuard: true, notCompanionRoot: true }))) return;
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
      // Hubs are never companions: hub commands are blocked in companion roots.
      if (!(await gate({ updateGuard: true, notCompanionRoot: true }))) return;
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
    case "workspace":
      // list/materialize are context-independent: no companion, install, or
      // update gating — an editor extension may call these frequently.
      if (!(await gate({}))) return;
      await runWorkspaceCommand(subcommand, rest);
      return;
    case "working":
      if (!(await gate({}))) return;
      await runWorkingCommand(subcommand, rest);
      return;
    case "wrap": {
      // Recording the answer is the point, so a recorded one must not suppress
      // the wizard; a bad flag is reported without prompting first.
      const wrapArgs = argv.slice(3);
      const parsedWrap = parseWrapArgs(wrapArgs);
      if ("error" in parsedWrap) {
        await runWrapCommand(wrapArgs);
        return;
      }
      const needs = { ignoreProjection: true, companion: parsedWrap.companion };
      if (!(await gate({ updateGuard: true, companion: needs, install: true }))) return;
      await runWrapCommand(wrapArgs);
      return;
    }
    case "unwrap":
      // A recovery path: it withdraws what a wrap placed, so it must never be
      // gated on a companion or an installation it does not consult.
      if (!(await gate({}))) return;
      await runUnwrapCommand(argv.slice(3));
      return;
    default:
      // Unknown commands fail fast: no case matched, so no gate ever ran.
      console.error(`Unknown command: ${command}`);
      console.error(usage());
      process.exitCode = 1;
  }
}
