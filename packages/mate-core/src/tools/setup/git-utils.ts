import fs from "node:fs/promises";
import path from "node:path";

// Resolves the path to the git info/exclude file for a repo, handling both
// plain .git directories and worktree-style .git files (`gitdir: <path>`).
export async function resolveGitInfoExcludePath(repoPath: string): Promise<string | null> {
  const gitPath = path.join(repoPath, ".git");
  let gitStat;
  try {
    gitStat = await fs.stat(gitPath);
  } catch {
    return null;
  }

  if (gitStat.isDirectory()) {
    return path.join(gitPath, "info", "exclude");
  }

  if (!gitStat.isFile()) {
    return null;
  }

  const rawGitDir = await fs.readFile(gitPath, "utf8");
  const match = rawGitDir.match(/^gitdir:\s*(.+)\s*$/m);
  if (!match) {
    return null;
  }

  return path.join(path.resolve(repoPath, match[1]), "info", "exclude");
}
