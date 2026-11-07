import { execFile } from "node:child_process";

import { umbrellaChildFolders, umbrellaFolderOf, umbrellaMirroredBy } from "./umbrella-folder";

function checkedOut(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: dir }, (error, out) =>
      resolve(error ? null : out.trim() || null),
    );
  });
}

/**
 * The branch checked out at `dir`; null when detached or outside Git. In a mirrored
 * umbrella worktree, the first attached child's in name order, as the VS Code extension
 * shows it; in an Umbrella Repository, null.
 */
export async function currentBranch(dir: string): Promise<string | null> {
  const umbrella = umbrellaFolderOf(dir);
  if (!umbrella) return checkedOut(dir);
  if (!umbrellaMirroredBy(umbrella)) return null;
  const branches = await Promise.all(umbrellaChildFolders(umbrella).map(checkedOut));
  return branches.find((branch) => branch !== null) ?? null;
}
