import path from "node:path";

import {
  CompanionResolver,
  type CompanionMatch,
  findRepoLocalRegistryFile,
} from "../../../lib/orchestrator/repository-link";
import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";
import { injectEditorFolder, getPreferredEditorCli } from "../../../lib/orchestrator/editor";
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
  injectEditorFolder,
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
 * @description Updates the managed `.mate/workspace.code-workspace` file with
 * the active working repository and every Linked Companion, then adds those
 * folders to the current editor window via `--add`.
 * @remarks Never selects a companion: no picker, no `MATE_ARTIFACT_PATH`
 * narrowing, and the companion recorded at the Projection Root is left as it
 * was. Stale companion pointers are skipped with a stderr warning. Throws
 * {@link WorkingRepoRequiredError} when no existing Linked Companion remains;
 * sets a non-zero exit code if the editor CLI is unavailable.
 */
export async function runWorkspaceOpenCommand(): Promise<void> {
  const cwd = workspaceOpenCommandDeps.cwd();
  const matches = await workspaceOpenCommandDeps.resolveCompanions(cwd);
  if (matches.length === 0) throw new WorkingRepoRequiredError("companion open");

  const repoPath = await workspaceOpenCommandDeps.findRepoRoot(cwd);
  const injected = await workspaceOpenCommandDeps.injectEditorFolder(
    orderCompanionPaths(cwd, matches),
    repoPath,
    workspaceOpenCommandDeps.getPreferredEditorCli(),
  );

  if (!injected) {
    process.exitCode = 1;
    return;
  }

  console.log(
    "Workspace: added to the current editor window; persistent file at .mate/workspace.code-workspace",
  );
}
