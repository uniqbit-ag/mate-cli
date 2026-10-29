import fs from "node:fs/promises";
import path from "node:path";

import { pathIsDirectory } from "../../lib/fs-utils";
import { withPathLock } from "../../runtime/companion-lock";
import { gitExcludePath, otherCheckouts } from "../../runtime/git-layout";
import { repoLocalDirPath } from "../../runtime/repo-local";
import { writeAtomicThroughLink } from "../../runtime/write-atomic";

const MANAGED_BLOCK_START = "# mate managed: start";
const MANAGED_BLOCK_END = "# mate managed: end";
/**
 * Documents no directory entry covers. `.opencode/` is per file: the repository's
 * own files there stay visible; copies get the copies block.
 */
const CORE_EXCLUDE_ENTRIES = [
  "/.mate/",
  "/.claude/",
  "/.opencode/opencode.json",
  "/.agents/",
  "/.mcp.json",
];
const LEGACY_CORE_EXCLUDE_ENTRIES = new Set([".mate/", ".claude/settings.local.json"]);

/**
 * For an edit: only a missing file is empty. Any other read error fails the
 * edit, since writing back what it could not read would drop the user's lines.
 */
async function readExcludeForEdit(excludePath: string): Promise<string> {
  try {
    return await fs.readFile(excludePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** For a presence check: a file it cannot read holds nothing it could find. */
function readExclude(excludePath: string): Promise<string> {
  return readExcludeForEdit(excludePath).catch(() => "");
}

function fileContent(lines: readonly string[]): string {
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** Split on `\n` alone, so a line keeps its `\r` and an untouched line its bytes. */
function contentLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function withoutManagedBlocks(lines: string[]): string[] {
  const next: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== MANAGED_BLOCK_START) {
      next.push(lines[index]);
      continue;
    }
    const end = lines.findIndex(
      (line, candidateIndex) => candidateIndex > index && line.trim() === MANAGED_BLOCK_END,
    );
    if (end === -1) {
      next.push(lines[index]);
      continue;
    }
    index = end;
  }
  return next;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  const next = [...lines];
  while (next.at(-1)?.trim() === "") next.pop();
  return next;
}

/** Held for one read-edit-write; a pass that cannot get it fails that entry. */
const EXCLUDE_LOCK_TIMEOUT_MS = 5_000;

/**
 * Rewrites the file's lines. `keep` holds entries another Checkout still needs;
 * the edit must leave them in place, wherever its rule would remove them.
 */
export type ExcludeEdit = (lines: string[], keep: ReadonlySet<string>) => string[];

/** The entries a Checkout of the same clone still needs in the shared file. */
export type ExcludeNeeds = (checkoutPath: string) => Promise<readonly string[]>;

export interface ExcludeEditResult {
  changed: boolean;
  /** Entries the edit would have removed but another Checkout still needs. */
  kept: string[];
  /** The Checkouts that need them. */
  keptFor: string[];
}

const UNCHANGED: ExcludeEditResult = { changed: false, kept: [], keptFor: [] };

function entries(lines: readonly string[]): Set<string> {
  return new Set(lines.map((line) => line.trim()).filter(Boolean));
}

/**
 * A Checkout Mate cannot reach, as a locked worktree whose drive is away, or
 * whose state it cannot read, keeps every entry: what it needs is unknown.
 */
async function checkoutNeeds(
  checkout: string,
  removed: ReadonlySet<string>,
  needs: ExcludeNeeds,
): Promise<readonly string[]> {
  if (!(await pathIsDirectory(checkout))) return [...removed];
  try {
    return await needs(checkout);
  } catch {
    return [...removed];
  }
}

/** Other Checkouts are read only here, once the edit would remove an entry. */
async function neededEntries(
  repoPath: string,
  removed: ReadonlySet<string>,
  needs: ExcludeNeeds,
): Promise<{ keep: Set<string>; keptFor: string[] }> {
  const checkouts = otherCheckouts(repoPath);
  const needed = await Promise.all(
    checkouts.map((checkout) => checkoutNeeds(checkout, removed, needs)),
  );
  const keep = new Set<string>();
  const keptFor: string[] = [];
  checkouts.forEach((checkout, index) => {
    const wanted = needed[index].filter((entry) => removed.has(entry));
    if (wanted.length === 0) return;
    keptFor.push(checkout);
    for (const entry of wanted) keep.add(entry);
  });
  return { keep, keptFor };
}

/** Runs `edit`, then again keeping what other Checkouts need once it would remove an entry. */
async function applyEdit(
  repoPath: string,
  current: string[],
  edit: ExcludeEdit,
  needs: ExcludeNeeds | undefined,
): Promise<{ lines: string[]; kept: string[]; keptFor: string[] }> {
  const lines = edit(current, new Set());
  const after = entries(lines);
  const removed = new Set([...entries(current)].filter((entry) => !after.has(entry)));
  if (!needs || removed.size === 0) return { lines, kept: [], keptFor: [] };
  const { keep, keptFor } = await neededEntries(repoPath, removed, needs);
  if (keep.size === 0) return { lines, kept: [], keptFor: [] };
  const keptLines = edit(current, keep);
  const stayed = entries(keptLines);
  return { lines: keptLines, kept: [...keep].filter((entry) => stayed.has(entry)), keptFor };
}

/**
 * The one writer for the exclude file Git reads for `repoPath`. Every Checkout
 * of a clone shares that file, so the read, the edit and the atomic replace
 * happen under one lock keyed by the file. With `needs`, an entry the edit
 * would remove stays while another Checkout of the clone needs it.
 *
 * Most passes change nothing. Those are settled by one read without the lock,
 * so sessions starting in several Checkouts at once do not queue on it.
 */
export async function editExcludeFile(
  repoPath: string,
  edit: ExcludeEdit,
  needs?: ExcludeNeeds,
): Promise<ExcludeEditResult> {
  const excludePath = gitExcludePath(repoPath);
  if (!excludePath) return UNCHANGED;
  const unlocked = await readExcludeForEdit(excludePath);
  if (fileContent(edit(contentLines(unlocked), new Set())) === unlocked) return UNCHANGED;
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  const locked = await withPathLock(
    "git-exclude",
    excludePath,
    { timeoutMs: EXCLUDE_LOCK_TIMEOUT_MS, pollMs: 20 },
    async () => {
      const existing = await readExcludeForEdit(excludePath);
      const { lines, kept, keptFor } = await applyEdit(
        repoPath,
        contentLines(existing),
        edit,
        needs,
      );
      const next = fileContent(lines);
      const changed = next !== existing;
      /** Through a symlink to its target, keeping the file's mode; a read-only file is refused. */
      if (changed) await writeAtomicThroughLink(excludePath, next);
      return { changed, kept, keptFor };
    },
  );
  if (!locked.acquired) throw new Error(`${excludePath} is locked by another Mate process`);
  return locked.value;
}

/** Appends `entry` unless a line already holds it; every other line stays as it is. */
export async function addExcludeLine(repoPath: string, entry: string): Promise<boolean> {
  const result = await editExcludeFile(repoPath, (lines) =>
    lines.some((line) => line.trim() === entry) ? lines : [...lines, entry],
  );
  return result.changed;
}

/** The first `startMarker`…`endMarker` pair, inclusive; `null` when either is missing. */
function findBlock(
  lines: string[],
  startMarker: string,
  endMarker: string,
): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.trim() === startMarker);
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && line.trim() === endMarker);
  return end === -1 ? null : { start, end };
}

function withoutLegacy(lines: string[]): string[] {
  return withoutManagedBlocks(lines).filter(
    (line) => !LEGACY_CORE_EXCLUDE_ENTRIES.has(line.trim()),
  );
}

export async function ensureWorkingRepoLocalExcludes(repoPath: string): Promise<boolean> {
  const block = [MANAGED_BLOCK_START, ...CORE_EXCLUDE_ENTRIES, MANAGED_BLOCK_END];
  const result = await editExcludeFile(repoPath, (current) => {
    /**
     * Rewritten where it stands, not moved to the end: a block that follows it,
     * like the companion copies', would otherwise trade places with it on every
     * pass and turn an unchanged wrap into a write.
     */
    const managed = findBlock(current, MANAGED_BLOCK_START, MANAGED_BLOCK_END);
    return managed
      ? trimTrailingEmptyLines([
          ...withoutLegacy(current.slice(0, managed.start)),
          ...block,
          ...withoutLegacy(current.slice(managed.end + 1)),
        ])
      : [...trimTrailingEmptyLines(withoutLegacy(current)), ...block];
  });
  return result.changed;
}

export function reconcileWorkingRepoCapabilityExcludes(
  repoPath: string,
  desiredEntries: string[],
  managedEntries: string[],
  needs: ExcludeNeeds,
): Promise<ExcludeEditResult> {
  const managed = new Set(managedEntries);
  const desired = new Set(desiredEntries);
  return editExcludeFile(
    repoPath,
    (current, keep) => {
      /**
       * A desired line stays where it stands: re-appending it would trade places
       * with a block written after it, like the companion copies', on every pass.
       */
      const lines = trimTrailingEmptyLines(
        current.filter((line) => {
          const entry = line.trim();
          return desired.has(entry) || keep.has(entry) || !managed.has(entry);
        }),
      );
      for (const entry of desiredEntries) {
        if (!lines.some((line) => line.trim() === entry)) lines.push(entry);
      }
      return lines;
    },
    needs,
  );
}

/** Whether the managed block is on disk; the block, not the exclude file. */
export async function managedWorkingRepoExcludesPresent(repoPath: string): Promise<boolean> {
  const excludePath = gitExcludePath(repoPath);
  if (!excludePath) return false;
  const lines = contentLines(await readExclude(excludePath));
  return lines.some((line) => line.trim() === MANAGED_BLOCK_START);
}

/** Whether any Capability-owned exclusion is present outside the managed block. */
export async function workingRepoCapabilityExcludesPresent(
  repoPath: string,
  candidateEntries: string[],
): Promise<boolean> {
  const excludePath = gitExcludePath(repoPath);
  if (!excludePath) return false;
  const lines = withoutManagedBlocks(contentLines(await readExclude(excludePath)));
  return candidateEntries.some((entry) => lines.some((line) => line.trim() === entry));
}

/**
 * A Checkout needs the whole managed block while it holds a Projection Root,
 * and the legacy lines too: an older wrap may have left only those.
 */
async function managedBlockNeeds(checkout: string): Promise<readonly string[]> {
  return (await pathIsDirectory(repoLocalDirPath(checkout)))
    ? [...CORE_EXCLUDE_ENTRIES, ...LEGACY_CORE_EXCLUDE_ENTRIES]
    : [];
}

/** The `.tokensave/`-style entries whose folder exists in the Checkout. */
export function localDataNeeds(candidateEntries: readonly string[]): ExcludeNeeds {
  return async (checkout) => {
    const present = await Promise.all(
      candidateEntries.map((entry) => pathIsDirectory(path.join(checkout, entry))),
    );
    return candidateEntries.filter((_, index) => present[index]);
  };
}

/**
 * The block goes as a whole or stays as a whole. A legacy line outside it
 * stays only while another Checkout needs the block's lines and the block is
 * gone, so the legacy line is all that hides that Checkout's files.
 */
export function removeWorkingRepoLocalExcludes(repoPath: string): Promise<ExcludeEditResult> {
  return editExcludeFile(
    repoPath,
    (current, keep) => {
      if (keep.size === 0) return trimTrailingEmptyLines(withoutLegacy(current));
      const hasBlock = findBlock(current, MANAGED_BLOCK_START, MANAGED_BLOCK_END) !== null;
      return trimTrailingEmptyLines(
        current.filter((line) => {
          const entry = line.trim();
          return !LEGACY_CORE_EXCLUDE_ENTRIES.has(entry) || (!hasBlock && keep.has(entry));
        }),
      );
    },
    managedBlockNeeds,
  );
}

const COPIES_BLOCK_START = "# mate managed copies: start";
const COPIES_BLOCK_END = "# mate managed copies: end";

/** A literal repo-relative path as an anchored exclude pattern. */
function literalExcludeEntry(relativePath: string): string {
  const escaped = relativePath.replace(/[\\*?[\]]/g, "\\$&");
  return `/${escaped}`;
}

function withoutCopiesBlock(lines: string[]): string[] {
  const block = findBlock(lines, COPIES_BLOCK_START, COPIES_BLOCK_END);
  return block ? [...lines.slice(0, block.start), ...lines.slice(block.end + 1)] : lines;
}

/**
 * One exclude line per owned companion copy, in a block of its own so the core
 * block's rewrite leaves it alone. Per file rather than `/.opencode/`, so a file
 * the repository adds there itself stays visible to Git. The block is shared
 * by the clone's Checkouts: `copiesOf` names the copies another one records,
 * whose lines stay.
 */
export function reconcileWorkingRepoCopyExcludes(
  repoPath: string,
  relativePaths: readonly string[],
  copiesOf: ExcludeNeeds,
): Promise<ExcludeEditResult> {
  const own = relativePaths.map(literalExcludeEntry);
  return editExcludeFile(
    repoPath,
    (current, keep) => {
      const lines = trimTrailingEmptyLines(withoutCopiesBlock(current));
      const block = [...new Set([...own, ...keep])].toSorted();
      if (block.length > 0) lines.push(COPIES_BLOCK_START, ...block, COPIES_BLOCK_END);
      return lines;
    },
    async (checkout) => (await copiesOf(checkout)).map(literalExcludeEntry),
  );
}
