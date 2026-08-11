import { usage } from "../../usage";
import { runWorkingCleanupCommand } from "./cleanup";

export async function runWorkingCommand(
  subcommand: string | undefined,
  argv: string[],
): Promise<void> {
  if (subcommand === "cleanup") {
    await runWorkingCleanupCommand(argv);
    return;
  }
  console.error(`Unknown working command: ${subcommand ?? ""}`);
  console.error(usage());
  process.exitCode = 1;
}
