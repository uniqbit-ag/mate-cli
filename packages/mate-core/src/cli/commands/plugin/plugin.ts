import { usage } from "../../usage";
import { type PluginInstallCommandDeps, runPluginInstallCommand } from "./install";

export async function runPluginCommand(
  subcommand: string | undefined,
  argv: string[],
  deps: PluginInstallCommandDeps = {},
): Promise<void> {
  switch (subcommand) {
    case "install":
      if (!(await runPluginInstallCommand(argv, deps))) process.exitCode = 1;
      return;
    default:
      console.error(`Unknown plugin command: ${subcommand ?? ""}`);
      console.error(usage());
      process.exitCode = 1;
  }
}
