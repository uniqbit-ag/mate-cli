export interface Worktree {
  path: string;
  /** Short branch name; absent when detached. */
  branch?: string;
  workset: boolean;
}

/** Parses `git worktree list --porcelain`; bare entries are skipped. */
export function parseWorktrees(porcelain: string): Worktree[] {
  const worktrees: Worktree[] = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((line) => line.trim());
    const pathLine = lines.find((line) => line.startsWith("worktree "));
    if (!pathLine || lines.includes("bare")) continue;
    const ref = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
    const branch = ref?.replace(/^refs\/heads\//, "");
    worktrees.push({
      path: pathLine.slice("worktree ".length),
      ...(branch ? { branch } : {}),
      workset: branch?.startsWith("workset/") ?? false,
    });
  }
  return worktrees;
}
