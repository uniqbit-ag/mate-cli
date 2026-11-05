import path from "node:path";

import {
  CompanionResolver,
  type CompanionMatch,
  findRepoLocalRegistryFile,
} from "../../../lib/orchestrator/repository-link";
import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";
import {
  editorWorkspacePath,
  getPreferredEditorCli,
  openEditorWorkspace,
  prepareEditorWorkspace,
} from "../../../lib/orchestrator/editor";
import { WorkingRepoRequiredError } from "../../../lib/orchestrator/types";
import { resolveProjection } from "../../../runtime/projection";
import { writeJsonStdout } from "../../write-json-stdout";

export const workspaceOpenCommandDeps = {
  cwd: () => process.cwd(),
  /**
   * The repo-local registry root, or the resolved cwd when there is none: the
   * global scan only matches a Working Repository on exact path equality.
   */
  findRepoRoot: async (cwd: string): Promise<string> =>
    (await findRepoLocalRegistryFile(cwd))?.repoRoot ?? path.resolve(cwd),
  /**
   * Every Linked Companion. Not `launchAmbiguityDeps.resolveLinkedCompanions`:
   * `logFailures` warns about each stale pointer the resolver drops, which
   * `wrap` and `session prepare` must not print.
   */
  resolveCompanions: async (cwd: string): Promise<CompanionMatch[]> => {
    const { match, ambiguousMatches } = await new CompanionResolver(
      new GlobalConfigStore(),
    ).resolveWithDiagnostics(cwd, { logFailures: true });
    if (ambiguousMatches.length > 0) return ambiguousMatches;
    return match ? [match] : [];
  },
  resolveProjection,
  getPreferredEditorCli: () => getPreferredEditorCli(),
  openEditorWorkspace,
  prepareEditorWorkspace,
};

/**
 * The projected companion first when it still links the repository, then the
 * rest by resolved path, so repeated runs write an identical workspace file.
 */
function orderCompanionPaths(cwd: string, matches: CompanionMatch[]): string[] {
  const linked = [...new Set(matches.map((match) => path.resolve(match.companionPath)))].toSorted();
  const projectedPath = workspaceOpenCommandDeps.resolveProjection(cwd)?.companionPath;
  const projected = projectedPath ? path.resolve(projectedPath) : null;
  if (!projected || !linked.includes(projected)) return linked;
  return [projected, ...linked.filter((companionPath) => companionPath !== projected)];
}

/**
 * @command mate companion open
 * @description Merges the active working repository, every Linked Companion,
 * and the worktree-detection settings into `.mate/<repo>.mate.code-workspace`,
 * keeping developer edits, then opens that file in the editor. A legacy
 * `.mate/workspace.code-workspace` is renamed to it once.
 * @flags
 * - `--no-open` — prepare the workspace without requiring or starting an editor.
 * - `--json` — print the absolute workspacePath as JSON instead of human output.
 * @remarks Never selects a companion: no picker, no `MATE_ARTIFACT_PATH`
 * narrowing, and the companion recorded at the Projection Root is left as it
 * was. Stale companion pointers are skipped with a stderr warning. Throws
 * {@link WorkingRepoRequiredError} when no existing Linked Companion remains;
 * sets a non-zero exit code if the editor CLI is unavailable or the workspace
 * file cannot be read, leaving that file unchanged.
 */
export async function runWorkspaceOpenCommand(argv: string[] = []): Promise<void> {
  const cwd = workspaceOpenCommandDeps.cwd();
  const matches = await workspaceOpenCommandDeps.resolveCompanions(cwd);
  if (matches.length === 0) throw new WorkingRepoRequiredError("companion open");

  const repoPath = await workspaceOpenCommandDeps.findRepoRoot(cwd);
  const companionPaths = orderCompanionPaths(cwd, matches);
  const noOpen = argv.includes("--no-open");
  if (noOpen) {
    const { workspacePath, error } = await workspaceOpenCommandDeps.prepareEditorWorkspace(
      companionPaths,
      repoPath,
    );
    if (error) {
      console.error(`mate: warning: ${workspacePath}: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  } else {
    const opened = await workspaceOpenCommandDeps.openEditorWorkspace(
      companionPaths,
      repoPath,
      workspaceOpenCommandDeps.getPreferredEditorCli(),
    );
    if (!opened) {
      process.exitCode = 1;
      return;
    }
  }

  const workspacePath = editorWorkspacePath(repoPath);
  if (argv.includes("--json")) {
    await writeJsonStdout({ workspacePath });
  } else {
    const documentPath = path.relative(repoPath, workspacePath);
    console.log(
      noOpen
        ? `Workspace: prepared ${documentPath}`
        : `Workspace: opened ${documentPath} in the editor`,
    );
  }
}
