import path from "node:path";

import { companionGit, type CompanionGit, outputLines } from "../../runtime/companion-git";

/**
 * Read-side Git helpers of Work. Share, Claim and Release commit through the pending-branch
 * transaction of `lib/delivery/staging/pending-edit.ts`; nothing here writes.
 */

/** Total budget for one network-bound Work operation. */
const WORK_NETWORK_BUDGET_MS = 30_000;
/** Bound on each local Git command. */
const WORK_COMMAND_CAP_MS = 10_000;

export type GitFailureKind =
  | "no-remote"
  | "authentication"
  | "offline"
  | "rejected"
  | "protected"
  | "timeout"
  | "failed";

export interface GitFailure {
  kind: GitFailureKind;
  /** Bounded and redacted; safe to show. */
  message: string;
}

export function workGit(companionPath: string): CompanionGit {
  return companionGit(companionPath, {
    prompt: "never",
    budgetMs: WORK_NETWORK_BUDGET_MS,
    commandCapMs: WORK_COMMAND_CAP_MS,
  });
}

async function firstLine(git: CompanionGit, args: string[]): Promise<string | null> {
  const result = await git.run(args);
  return result.status === 0 ? (outputLines(result.stdout)[0] ?? null) : null;
}

/** Whether the companion is a Git checkout; outside Git there is no sharing. */
export async function isGitBacked(git: CompanionGit): Promise<boolean> {
  return (await git.run(["rev-parse", "--git-dir"])).status === 0;
}

/** The commit `ref` names, or null when it does not exist. */
export async function refCommit(git: CompanionGit, ref: string): Promise<string | null> {
  return firstLine(git, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
}

/** When `ref` last moved, from its reflog; undefined without one. */
export async function fetchedAt(git: CompanionGit, ref: string): Promise<string | undefined> {
  const line = await firstLine(git, [
    "reflog",
    "show",
    "-n",
    "1",
    "--date=iso-strict",
    "--format=%gd",
    ref,
  ]);
  const date = line ? /@\{(.+)\}$/.exec(line)?.[1] : undefined;
  return date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : undefined;
}

/** Path → blob id below `prefixes` in a commit. */
export async function treeBlobs(
  git: CompanionGit,
  commit: string,
  prefixes: readonly string[],
): Promise<Map<string, { blob: string; mode: string }>> {
  const result = await git.run(["ls-tree", "-r", "-z", "--full-tree", commit, "--", ...prefixes]);
  const blobs = new Map<string, { blob: string; mode: string }>();
  if (result.status !== 0) return blobs;
  for (const entry of result.stdout.split("\0")) {
    const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
    if (match) blobs.set(match[3]!, { blob: match[2]!, mode: match[1]! });
  }
  return blobs;
}

/** Blob ids of companion files as Git would store them, without writing them. */
export async function hashFiles(
  git: CompanionGit,
  companionPath: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  if (paths.length === 0) return hashes;
  const result = await git.run([
    "hash-object",
    "--",
    ...paths.map((relative) => path.join(companionPath, ...relative.split("/"))),
  ]);
  if (result.status !== 0) return hashes;
  outputLines(result.stdout).forEach((blob, index) => hashes.set(paths[index]!, blob));
  return hashes;
}

export async function readBlob(git: CompanionGit, blob: string): Promise<string | null> {
  const result = await git.run(["cat-file", "blob", blob]);
  return result.status === 0 ? result.stdout : null;
}

/** Configured Git identity of the companion: name as label, email as stable id. */
export async function configuredOperator(
  git: CompanionGit,
): Promise<{ id: string; label: string } | null> {
  const [label, id] = await Promise.all([
    firstLine(git, ["config", "--get", "user.name"]),
    firstLine(git, ["config", "--get", "user.email"]),
  ]);
  if (!label?.trim() || !id?.trim() || !/^[^\s@]+@[^\s@]+$/.test(id.trim())) return null;
  return { id: id.trim().toLowerCase(), label: label.trim() };
}
