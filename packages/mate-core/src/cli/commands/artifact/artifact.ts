import { usage } from "../../usage";
import { runArtifactFinishCommand } from "./finish";

/**
 * @command mate artifact <subcommand>
 * @description Dispatches to the supported `artifact` subcommands. Prints usage
 * and sets a non-zero exit code for an unrecognized subcommand.
 */
export async function runArtifactCommand(
  subcommand: string | undefined,
  argv: string[],
): Promise<void> {
  switch (subcommand) {
    case "finish":
      await runArtifactFinishCommand(argv);
      return;
    default:
      console.error(`Unknown artifact command: ${subcommand ?? ""}`);
      console.error(usage());
      process.exitCode = 1;
  }
}
