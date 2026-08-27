import fs from "node:fs/promises";
import path from "node:path";

import { companionLinkPath } from "../../runtime/repo-local";

/**
 * The one filesystem fact behind "separated but visible": a link at the
 * Projection Root that makes the Companion Repository reachable by ordinary
 * path traversal, for every tool, editor and GUI at once. It replaces no
 * per-runtime directory allow-list — those stay as the fallback for a platform
 * that permits no link at all.
 */

/**
 * A Windows symbolic link needs Developer Mode or elevation; a directory
 * junction needs neither, and Node creates one through the same call.
 */
async function createLink(target: string, link: string): Promise<void> {
  await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

/** Absolute, so the link survives the Working Repository being moved into place. */
async function currentTarget(link: string): Promise<string | null> {
  const target = await fs.readlink(link).catch(() => null);
  return target === null ? null : path.resolve(path.dirname(link), target);
}

export async function linkCompanion(
  repoPath: string,
  companionPath: string,
): Promise<"written" | "current"> {
  const link = companionLinkPath(repoPath);
  const target = path.resolve(companionPath);

  const existing = await currentTarget(link);
  if (existing === target) return "current";

  await fs.mkdir(path.dirname(link), { recursive: true });
  if (existing !== null) await fs.unlink(link);
  await createLink(target, link);
  return "written";
}

/**
 * `unlink` acts on the link itself. Nothing here may recurse: a recursive
 * removal at this path would walk into the Companion Repository and delete the
 * Artifacts the link exists to expose.
 */
export async function unlinkCompanion(repoPath: string): Promise<"removed" | "absent"> {
  const link = companionLinkPath(repoPath);
  if (!(await fs.lstat(link).catch(() => null))) return "absent";
  await fs.unlink(link);
  return "removed";
}

/** `lstat`, not `access`: a link whose target is gone is still Mate's to remove. */
export async function companionLinkPresent(repoPath: string): Promise<boolean> {
  return fs
    .lstat(companionLinkPath(repoPath))
    .then(() => true)
    .catch(() => false);
}
