import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { errorMessage } from "../../runtime/error-message";
import type { GitRunner } from "./worktree";

/** Shared with tools that read the same file (Claude Code, Conductor). */
const INCLUDE_FILE = ".worktreeinclude";
/** Mate-only; used while Git ignores it. */
const LOCAL_INCLUDE_FILE = ".worktreeinclude.local";

export interface IncludeOutcome {
  /** The include files used, in pattern order. */
  sources: string[];
  /** Paths copied into the worktree, relative to the repository root. */
  copied: string[];
  /** Selected paths that were not copied; `reason` never holds file contents. */
  failed: { path: string; reason: string }[];
}

export interface IncludeSelection {
  sources: string[];
  paths: string[];
  warnings: string[];
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/** Splits `-z` output; Git ends every entry with NUL. */
function entries(stdout: string): string[] {
  return stdout.split("\0").filter(Boolean);
}

/**
 * Untracked files of `checkout` that match its include files and its standard ignore
 * rules. Git matches, so gitignore semantics, `**`, directories and non-ASCII paths
 * behave as Git defines them.
 */
export async function selectIncludedFiles(
  git: GitRunner,
  checkout: string,
): Promise<IncludeSelection> {
  const sources: string[] = [];
  const warnings: string[] = [];
  if (await isFile(path.join(checkout, INCLUDE_FILE))) sources.push(INCLUDE_FILE);
  if (await isFile(path.join(checkout, LOCAL_INCLUDE_FILE))) {
    // Tracked files never count as ignored, so this also refuses a committed one.
    const ignored = await git(checkout, ["check-ignore", "-q", "--", LOCAL_INCLUDE_FILE]);
    if (ignored.code === 0) sources.push(LOCAL_INCLUDE_FILE);
    else warnings.push(`${LOCAL_INCLUDE_FILE} skipped: Git does not ignore it`);
  }
  if (sources.length === 0) return { sources, paths: [], warnings };
  const listed = await git(checkout, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    ...sources.map((source) => `--exclude-from=${path.join(checkout, source)}`),
  ]);
  if (listed.code !== 0) {
    warnings.push(`listing include files failed: ${listed.stderr.trim()}`);
    return { sources, paths: [], warnings };
  }
  // Install owns `node_modules`; a short pattern such as `.env` would also match in packages.
  const candidates = entries(listed.stdout).filter(
    (entry) => !entry.split("/").includes("node_modules"),
  );
  if (candidates.length === 0) return { sources, paths: [], warnings };
  // Exit 1 means none is ignored.
  const checked = await git(checkout, ["check-ignore", "-z", "--stdin"], {
    input: `${candidates.join("\0")}\0`,
  });
  if (checked.code > 1) {
    warnings.push(`checking ignored include files failed: ${checked.stderr.trim()}`);
    return { sources, paths: [], warnings };
  }
  return { sources, paths: entries(checked.stdout).toSorted(), warnings };
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Resolves symlinks in the longest existing prefix of `candidate`. */
async function realpathExisting(candidate: string): Promise<string> {
  try {
    return await fs.realpath(candidate);
  } catch (error) {
    const parent = path.dirname(candidate);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === candidate) throw error;
    return path.join(await realpathExisting(parent), path.basename(candidate));
  }
}

type CopyResult = "copied" | "skipped" | { reason: string };

async function copyOne(
  checkout: string,
  worktree: string,
  realWorktree: string,
  entry: string,
): Promise<CopyResult> {
  const source = path.join(checkout, entry);
  // Symbolic links and other non-regular files are not copied.
  if (!(await fs.lstat(source)).isFile()) return "skipped";
  const target = path.join(worktree, entry);
  // Checked before mkdir: a symlinked parent inside the worktree could lead elsewhere.
  const realTarget = path.join(await realpathExisting(path.dirname(target)), path.basename(target));
  if (!inside(worktree, target) || !inside(realWorktree, realTarget)) {
    return { reason: "outside the worktree" };
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    // Keeps the source's permission bits.
    await fs.copyFile(source, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "skipped";
    throw error;
  }
  return "copied";
}

/**
 * Copies the selected regular files from `checkout` to `worktree`, never overwriting an
 * existing path; a failure is recorded and the rest still run.
 */
export async function copyIncludedFiles(
  checkout: string,
  worktree: string,
  selection: IncludeSelection,
): Promise<IncludeOutcome> {
  const outcome: IncludeOutcome = { sources: selection.sources, copied: [], failed: [] };
  if (selection.paths.length === 0) return outcome;
  const realWorktree = await fs.realpath(worktree);
  for (const entry of selection.paths) {
    let result: CopyResult;
    try {
      // oxlint-disable-next-line no-await-in-loop -- parents may be shared between entries
      result = await copyOne(checkout, worktree, realWorktree, entry);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      result = { reason: code ?? errorMessage(error) };
    }
    if (result === "copied") outcome.copied.push(entry);
    else if (result !== "skipped") outcome.failed.push({ path: entry, reason: result.reason });
  }
  return outcome;
}
