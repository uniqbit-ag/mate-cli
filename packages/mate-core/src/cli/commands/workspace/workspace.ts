import { usage } from "../../usage";
import { runWorkspaceListCommand } from "./list";
import { runWorkspaceMaterializeCommand } from "./materialize";
import { runWorkspaceResolveCommand } from "./resolve";
import { runWorkspaceResolveHookCommand } from "./resolve-hook";

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
    case "resolve":
      await runWorkspaceResolveCommand(argv);
      return;
    case "resolve-hook":
      await runWorkspaceResolveHookCommand(argv);
      return;
    default:
      console.error(`Unknown workspace command: ${subcommand ?? ""}`);
      console.error(usage());
      process.exitCode = 1;
  }
}
