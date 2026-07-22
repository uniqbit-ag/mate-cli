import { usage } from "../../usage";
import { runCompanionLinkCommand } from "./link";
import { runSetupCommand } from "../setup";
import { runCompanionListCommand } from "./list";
import { runWorkspaceOpenCommand } from "../workspace/open";
import { runCompanionTuiCommand } from "./tui";

export async function runCompanionCommand(
  subcommand: string | undefined,
  argv: string[],
): Promise<void> {
  switch (subcommand) {
    case "link":
      await runCompanionLinkCommand(argv);
      return;
    case "setup":
      await runSetupCommand(argv);
      return;
    case "list":
      await runCompanionListCommand(argv);
      return;
    case "open":
      await runWorkspaceOpenCommand();
      return;
    case "tui":
      await runCompanionTuiCommand();
      return;
    default:
      console.error(`Unknown companion command: ${subcommand ?? ""}`);
      console.error(usage());
      process.exitCode = 1;
  }
}
