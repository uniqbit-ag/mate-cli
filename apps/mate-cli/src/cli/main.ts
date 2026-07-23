import { version } from "../../package.json";
import {
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
}

const mainDeps: MainDeps = {
  ensureUnambiguousCompanion,
  inspectInstallPreflight,
};

export async function main(argv = process.argv, deps: MainDeps = mainDeps): Promise<void> {
  const [, , command, subcommand, ...rest] = argv;

  if (command === "-v" || command === "--version") {
    console.log(version);
    return;
  }

  const updateStore = new UpdateStateStore();
  await showUpdateBannerIfAvailable(updateStore);
  scheduleBackgroundCheck(updateStore);

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
      console.error(`mate: ${preflight.reason ?? "installation is incomplete"}`);
      console.error("Run `mate install` before continuing.");
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
    case "codex":
      await runLaunchCodexCommand(argv.slice(3), { directPassthrough: true });
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
