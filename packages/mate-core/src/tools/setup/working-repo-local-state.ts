import fs from "node:fs/promises";
import path from "node:path";

import { resolveGitInfoExcludePath } from "./git-utils";

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

async function readExclude(excludePath: string): Promise<string> {
  try {
    return await fs.readFile(excludePath, "utf8");
  } catch {
    return "";
  }
}

function contentLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
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

async function writeExclude(
  excludePath: string,
  existing: string,
  lines: string[],
): Promise<boolean> {
  const nextContent = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  if (nextContent === existing) return false;
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.writeFile(excludePath, nextContent, "utf8");
  return true;
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
  const excludePath = await resolveGitInfoExcludePath(repoPath);
  if (!excludePath) return false;
  const existing = await readExclude(excludePath);
  const current = contentLines(existing);
  const block = [MANAGED_BLOCK_START, ...CORE_EXCLUDE_ENTRIES, MANAGED_BLOCK_END];
  /**
   * Rewritten where it stands, not moved to the end: a block that follows it,
   * like the companion copies', would otherwise trade places with it on every
   * pass and turn an unchanged wrap into a write.
   */
  const managed = findBlock(current, MANAGED_BLOCK_START, MANAGED_BLOCK_END);
  const lines = managed
    ? trimTrailingEmptyLines([
        ...withoutLegacy(current.slice(0, managed.start)),
        ...block,
        ...withoutLegacy(current.slice(managed.end + 1)),
      ])
    : [...trimTrailingEmptyLines(withoutLegacy(current)), ...block];
  return writeExclude(excludePath, existing, lines);
}

export async function reconcileWorkingRepoCapabilityExcludes(
  repoPath: string,
  desiredEntries: string[],
  managedEntries: string[],
): Promise<boolean> {
  const excludePath = await resolveGitInfoExcludePath(repoPath);
  if (!excludePath) return false;
  const existing = await readExclude(excludePath);
  const managed = new Set(managedEntries);
  const desired = new Set(desiredEntries);
  /**
   * A desired line stays where it stands: re-appending it would trade places
   * with a block written after it, like the companion copies', on every pass.
   */
  const lines = trimTrailingEmptyLines(
    contentLines(existing).filter((line) => {
      const entry = line.trim();
      return desired.has(entry) || !managed.has(entry);
    }),
  );
  for (const entry of desiredEntries) {
    if (!lines.some((line) => line.trim() === entry)) lines.push(entry);
  }
  return writeExclude(excludePath, existing, lines);
}

/** Whether the managed block is on disk; the block, not the exclude file. */
export async function managedWorkingRepoExcludesPresent(repoPath: string): Promise<boolean> {
  const excludePath = await resolveGitInfoExcludePath(repoPath);
  if (!excludePath) return false;
  const lines = contentLines(await readExclude(excludePath));
  return lines.some((line) => line.trim() === MANAGED_BLOCK_START);
}

/** Whether any Capability-owned exclusion is present outside the managed block. */
export async function workingRepoCapabilityExcludesPresent(
  repoPath: string,
  candidateEntries: string[],
): Promise<boolean> {
  const excludePath = await resolveGitInfoExcludePath(repoPath);
  if (!excludePath) return false;
  const lines = withoutManagedBlocks(contentLines(await readExclude(excludePath)));
  return candidateEntries.some((entry) => lines.some((line) => line.trim() === entry));
}

export async function removeWorkingRepoLocalExcludes(repoPath: string): Promise<boolean> {
  const excludePath = await resolveGitInfoExcludePath(repoPath);
  if (!excludePath) return false;
  const existing = await readExclude(excludePath);
  const lines = trimTrailingEmptyLines(withoutLegacy(contentLines(existing)));
  return writeExclude(excludePath, existing, lines);
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
 * the repository adds there itself stays visible to Git.
 */
export async function reconcileWorkingRepoCopyExcludes(
  repoPath: string,
  relativePaths: readonly string[],
): Promise<boolean> {
  const excludePath = await resolveGitInfoExcludePath(repoPath);
  if (!excludePath) return false;
  const existing = await readExclude(excludePath);
  const lines = trimTrailingEmptyLines(withoutCopiesBlock(contentLines(existing)));
  if (relativePaths.length > 0) {
    lines.push(
      COPIES_BLOCK_START,
      ...relativePaths.toSorted().map(literalExcludeEntry),
      COPIES_BLOCK_END,
    );
  }
  return writeExclude(excludePath, existing, lines);
}
