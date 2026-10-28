import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Real Git layouts for tests: clones with worktrees, a bare repository, a
 * submodule. Relative worktree paths where Git supports them, so the reader
 * meets both spellings; an older Git ignores the setting.
 */

const GIT_CONFIG = [
  "-c",
  "user.name=acme",
  "-c",
  "user.email=acme@example.com",
  "-c",
  "init.defaultBranch=main",
  "-c",
  "protocol.file.allow=always",
  "-c",
  "worktree.useRelativePaths=true",
];

export function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  return execFileSync("git", [...GIT_CONFIG, ...args], { cwd, env, encoding: "utf8" });
}

/** A repository with one commit, so worktrees can be added to it. */
export function initRepo(repoPath: string): string {
  git(path.dirname(repoPath), "init", "-q", repoPath);
  git(repoPath, "commit", "-q", "--allow-empty", "-m", "init");
  return repoPath;
}

export function addWorktree(repoPath: string, worktreePath: string): string {
  git(repoPath, "worktree", "add", "-q", "--detach", worktreePath);
  return worktreePath;
}

/** A bare clone of a fresh repository, with no main worktree of its own. */
export function initBareRepo(root: string, name = "acme.git"): string {
  const source = initRepo(path.join(root, "acme-source"));
  const bare = path.join(root, name);
  git(root, "clone", "-q", "--bare", source, bare);
  return bare;
}
