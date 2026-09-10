import { usage } from "../../usage";
import { runArtifactPublishCommand } from "./finish";
import { runArtifactPendingCommand } from "./pending";

/**
 * Pre-rename spelling of `publish`. Kept so companions whose materialized skills were
 * written before the rename keep working until they re-sync.
 */
const DEPRECATED_PUBLISH_ALIAS = "finish";

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
    case DEPRECATED_PUBLISH_ALIAS:
      console.error(
        "mate: `artifact finish` is deprecated and will be removed; use `artifact publish`.",
      );
      await runArtifactPublishCommand(argv);
      return;
    case "publish":
      await runArtifactPublishCommand(argv);
      return;
    case "pending":
      await runArtifactPendingCommand(argv);
      return;
    default:
      console.error(`Unknown artifact command: ${subcommand ?? ""}`);
      console.error(usage());
      process.exitCode = 1;
  }
}
