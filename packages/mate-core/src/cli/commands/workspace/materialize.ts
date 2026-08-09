import { materializeWorkspace } from "../../../lib/orchestrator/workspace-materialize";
import { writeJsonStdout } from "../../write-json-stdout";

export const workspaceMaterializeCommandDeps = {
  materializeWorkspace: (repositoryId: string, companionPath: string) =>
    materializeWorkspace({ repositoryId, companionPath }),
};

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * @command mate workspace materialize
 * @description Validates an explicit repository/companion pairing, writes
 * the generated `.mate/workspace.code-workspace` file, and prints its path
 * and folder order as one JSON document. Never spawns or focuses an editor.
 * @flags
 * - `--repository <id>` — required; the linked repository id to pair.
 * - `--companion <path>` — required; the companion path that must link it.
 * - `--json` — required; this command only supports JSON output.
 */
export async function runWorkspaceMaterializeCommand(argv: string[] = []): Promise<void> {
  const repositoryId = readFlag(argv, "--repository");
  const companionPath = readFlag(argv, "--companion");

  if (!repositoryId || !companionPath || !argv.includes("--json")) {
    process.stderr.write(
      "mate: `workspace materialize` requires --repository <id>, --companion <path>, and --json.\n",
    );
    process.exitCode = 1;
    return;
  }

  try {
    const result = await workspaceMaterializeCommandDeps.materializeWorkspace(
      repositoryId,
      companionPath,
    );
    await writeJsonStdout(result);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
