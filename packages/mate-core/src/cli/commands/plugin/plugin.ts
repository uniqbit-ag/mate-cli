import { usage } from "../../usage";
import { runPluginInstallCommand } from "./install";
import { runPluginVerifyCommand } from "./verify";

export async function runPluginCommand(
  subcommand: string | undefined,
  argv: string[],
): Promise<void> {
  switch (subcommand) {
    case "install":
      await runPluginInstallCommand(argv);
      return;
    case "verify":
      await runPluginVerifyCommand();
      return;
    default:
      console.error(`Unknown plugin command: ${subcommand ?? ""}`);
      console.error(usage());
      process.exitCode = 1;
  }
}
