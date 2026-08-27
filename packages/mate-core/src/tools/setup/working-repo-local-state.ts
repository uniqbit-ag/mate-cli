import fs from "node:fs/promises";
import path from "node:path";

import { resolveGitInfoExcludePath } from "./git-utils";

const MANAGED_BLOCK_START = "# mate managed: start";
const MANAGED_BLOCK_END = "# mate managed: end";
/** `.mcp.json` is the one working-target document no directory entry covers. */
const CORE_EXCLUDE_ENTRIES = ["/.mate/", "/.claude/", "/.opencode/", "/.agents/", "/.mcp.json"];
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

export async function ensureWorkingRepoLocalExcludes(repoPath: string): Promise<boolean> {
  const excludePath = await resolveGitInfoExcludePath(repoPath);
  if (!excludePath) return false;
  const existing = await readExclude(excludePath);
  const lines = trimTrailingEmptyLines(
    withoutManagedBlocks(contentLines(existing)).filter(
      (line) => !LEGACY_CORE_EXCLUDE_ENTRIES.has(line.trim()),
    ),
  );
  lines.push(MANAGED_BLOCK_START, ...CORE_EXCLUDE_ENTRIES, MANAGED_BLOCK_END);
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
  const lines = trimTrailingEmptyLines(
    contentLines(existing).filter((line) => !managed.has(line.trim())),
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
  const lines = trimTrailingEmptyLines(
    withoutManagedBlocks(contentLines(existing)).filter(
      (line) => !LEGACY_CORE_EXCLUDE_ENTRIES.has(line.trim()),
    ),
  );
  return writeExclude(excludePath, existing, lines);
}
