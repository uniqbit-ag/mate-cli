import { usage } from "../../usage";
import { runWorkspaceListCommand } from "./list";
import { runWorkspaceMaterializeCommand } from "./materialize";

/** Dispatches `mate workspace <subcommand>`. Distinct from `mate companion open`. */
export async function runWorkspaceCommand(
  subcommand: string | undefined,
  argv: string[],
): Promise<void> {
  switch (subcommand) {
    case "list":
      await runWorkspaceListCommand(argv);
      return;
    case "materialize":
      await runWorkspaceMaterializeCommand(argv);
      return;
    default:
      console.error(`Unknown workspace command: ${subcommand ?? ""}`);
      console.error(usage());
      process.exitCode = 1;
  }
}
