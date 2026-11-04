import { usage } from "../../usage";
import { runWorkingCleanupCommand } from "./cleanup";
import { runWorkingLinkCommand } from "./link";
import { runWorkingWorktreeCommand } from "./worktree";

export async function runWorkingCommand(
  subcommand: string | undefined,
  argv: string[],
): Promise<void> {
  if (subcommand === "link") {
    await runWorkingLinkCommand(argv);
    return;
  }
  if (subcommand === "cleanup") {
    await runWorkingCleanupCommand(argv);
    return;
  }
  if (subcommand === "worktree") {
    await runWorkingWorktreeCommand(argv);
    return;
  }
  console.error(`Unknown working command: ${subcommand ?? ""}`);
  console.error(usage());
  process.exitCode = 1;
}
