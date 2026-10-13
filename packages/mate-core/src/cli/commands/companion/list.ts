import { CompanionStore } from "../../../lib/orchestrator/repository-link";
import { resolveFrameworkContext } from "../../../lib/orchestrator/framework-context";
import { renderRepoListTable } from "../../repo-list-table";
import { writeJsonStdout } from "../../write-json-stdout";

/**
 * @command mate companion list
 * @description Lists repositories linked to the current companion, marking
 * the active one (from the `MATE_REPO_ID` env var) in the rendered table.
 * @flags
 * - `--json` — force JSON output instead of the rendered table.
 * @remarks Output is also switched to JSON automatically when stdout is not a
 * TTY (e.g. piped into another command).
 */
export async function runCompanionListCommand(argv: string[] = []): Promise<void> {
  const { companionPath, workingRepoStore, repository, contextKind } =
    await resolveFrameworkContext(process.cwd());
  const repositories = repository
    ? [repository]
    : contextKind === "companion-root"
      ? []
      : await new CompanionStore(companionPath, workingRepoStore).listRepositories();
  const forceJson = argv.includes("--json");

  if (forceJson || !process.stdout.isTTY) {
    await writeJsonStdout({ repositories });
    return;
  }

  await renderRepoListTable(repositories, process.env.MATE_REPO_ID);
}
