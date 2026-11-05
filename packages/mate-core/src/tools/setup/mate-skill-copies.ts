import { companionGit } from "../../runtime/companion-git";

/** Companion roots Mate deploys its skill copies into, independent of active runtimes. */
const SKILL_ROOTS = [".claude/skills", ".agents/skills"] as const;

/**
 * Managed `.gitignore` entries for Mate-owned skill copies, by exact name so a
 * companion-authored skill sharing a prefix stays tracked.
 */
export function skillIgnoreEntries(names: readonly string[]): string[] {
  return names.flatMap((name) => SKILL_ROOTS.map((root) => `${root}/${name}/`));
}

export function isSkillIgnoreEntry(entry: string): boolean {
  return SKILL_ROOTS.some((root) => entry.startsWith(`${root}/`));
}

/**
 * Removes tracked files under the skill entries among `entries` from the index,
 * keeping them on disk. Returns every path staged as a deletion under those entries,
 * including removals an earlier, uncommitted run left; none outside a Git repository.
 */
export async function untrackSkillCopies(
  companionPath: string,
  entries: readonly string[],
): Promise<string[]> {
  const pathspecs = entries.filter(isSkillIgnoreEntry);
  if (pathspecs.length === 0) return [];
  const git = companionGit(companionPath, { prompt: "never" });
  const listed = await git.run(["ls-files", "--cached", "-z", "--", ...pathspecs]);
  if (listed.status !== 0) return [];
  const tracked = listed.stdout.split("\0").filter(Boolean);
  if (tracked.length > 0) {
    // `-f`: a staged edit to a copy differs from both HEAD and the file; drop it anyway.
    const removed = await git.run(["rm", "--cached", "-r", "-f", "--quiet", "--", ...tracked]);
    if (removed.status !== 0) {
      throw new Error(`git rm --cached failed: ${removed.stderr.trim() || removed.stdout.trim()}`);
    }
  }
  const staged = await git.run([
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--diff-filter=D",
    "--",
    ...pathspecs,
  ]);
  if (staged.status !== 0) return tracked;
  return staged.stdout.split("\0").filter(Boolean);
}
