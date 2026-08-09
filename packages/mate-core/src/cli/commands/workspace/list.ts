import { collectWorkspaceInventory } from "../../../lib/orchestrator/workspace-inventory";
import { writeJsonStdout } from "../../write-json-stdout";

export const workspaceListCommandDeps = {
  collectWorkspaceInventory: () => collectWorkspaceInventory(),
};

/**
 * @command mate workspace list
 * @description Prints the aggregate inventory of registered companions and
 * their linked working-repository pairings as one JSON document. Runs
 * without a linked working repository or any active companion context.
 * @flags
 * - `--json` — required; this command only supports JSON output.
 */
export async function runWorkspaceListCommand(argv: string[] = []): Promise<void> {
  if (!argv.includes("--json")) {
    process.stderr.write("mate: `workspace list` requires --json.\n");
    process.exitCode = 1;
    return;
  }

  const inventory = await workspaceListCommandDeps.collectWorkspaceInventory();
  await writeJsonStdout(inventory);
}
