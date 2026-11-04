import path from "node:path";

import {
  CompanionResolver,
  type CompanionMatch,
  findRepoLocalRegistryFile,
} from "../../../lib/orchestrator/repository-link";
import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";
import { openEditorWorkspace, getPreferredEditorCli } from "../../../lib/orchestrator/editor";
import { WorkingRepoRequiredError } from "../../../lib/orchestrator/types";
import { resolveProjection } from "../../../runtime/projection";

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
 * and the worktree-detection settings into `.mate/workspace.code-workspace`,
 * keeping developer edits, then opens that file in the editor.
 * @remarks Never selects a companion: no picker, no `MATE_ARTIFACT_PATH`
 * narrowing, and the companion recorded at the Projection Root is left as it
 * was. Stale companion pointers are skipped with a stderr warning. Throws
 * {@link WorkingRepoRequiredError} when no existing Linked Companion remains;
 * sets a non-zero exit code if the editor CLI is unavailable or the workspace
 * file cannot be read, leaving that file unchanged.
 */
export async function runWorkspaceOpenCommand(): Promise<void> {
  const cwd = workspaceOpenCommandDeps.cwd();
  const matches = await workspaceOpenCommandDeps.resolveCompanions(cwd);
  if (matches.length === 0) throw new WorkingRepoRequiredError("companion open");

  const repoPath = await workspaceOpenCommandDeps.findRepoRoot(cwd);
  const opened = await workspaceOpenCommandDeps.openEditorWorkspace(
    orderCompanionPaths(cwd, matches),
    repoPath,
    workspaceOpenCommandDeps.getPreferredEditorCli(),
  );

  if (!opened) {
    process.exitCode = 1;
    return;
  }

  console.log("Workspace: opened .mate/workspace.code-workspace in the editor");
}
