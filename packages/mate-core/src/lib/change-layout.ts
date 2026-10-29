import fs from "node:fs/promises";
import path from "node:path";

import { pathIsDirectory } from "./fs-utils";

/**
 * Where a change lives in a Companion Repository: the active `openspec/changes/<name>/`
 * directory, its dated archive `openspec/changes/archive/YYYY-MM-DD-<name>/`, and the
 * canonical specs its delta specs map to. Only directories count, and only names are read.
 */

/** Companion-relative POSIX paths. */
export const CHANGES_RELATIVE_DIR = "openspec/changes";
export const ARCHIVE_RELATIVE_DIR = "openspec/changes/archive";
export const SPECS_RELATIVE_DIR = "openspec/specs";

const ARCHIVE_DIR_NAME = "archive";

/**
 * One path segment: no separator, NUL, or leading dot (so never `.`, `..`, or hidden).
 * Wider than OpenSpec's kebab-case, so archives made under older rules still resolve.
 */
const SEGMENT = /^[^./\\\0][^/\\\0]*$/;

/** The `YYYY-MM-DD-<name>` anchor `openspec archive` gives an archived change. */
const ANCHOR = /^(\d{4}-\d{2}-\d{2})-(.+)$/;

export function changesDirOf(companionPath: string): string {
  return path.join(companionPath, ...CHANGES_RELATIVE_DIR.split("/"));
}

export function archiveDirOf(companionPath: string): string {
  return path.join(companionPath, ...ARCHIVE_RELATIVE_DIR.split("/"));
}

/** A change name or archive anchor: one path segment that is not the archive directory. */
export function isChangeName(candidate: string): boolean {
  return SEGMENT.test(candidate) && candidate !== ARCHIVE_DIR_NAME;
}

export interface Anchor {
  date: string;
  name: string;
}

/** `2026-01-02-acme` → `{date: "2026-01-02", name: "acme"}`; null for anything else, `2026-01-02-` included. */
export function parseAnchor(candidate: string): Anchor | null {
  const match = ANCHOR.exec(candidate);
  if (!match || !isChangeName(match[2])) return null;
  return { date: match[1], name: match[2] };
}

/** The change name of an archive anchor (`2026-01-02-acme` → `acme`); other names pass through. */
export function changeNameOf(anchorOrName: string): string {
  return parseAnchor(anchorOrName)?.name ?? anchorOrName;
}

async function directoryNames(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Active change names, sorted. */
export async function activeChanges(companionPath: string): Promise<string[]> {
  return (await directoryNames(changesDirOf(companionPath))).filter(isChangeName).toSorted();
}

/** Archive anchors, optionally only those of change `name`, sorted oldest first. */
export async function archiveAnchors(companionPath: string, name?: string): Promise<string[]> {
  return (await directoryNames(archiveDirOf(companionPath)))
    .filter((anchor) => {
      const parsed = parseAnchor(anchor);
      return parsed !== null && (name === undefined || parsed.name === name);
    })
    .toSorted();
}

export interface ChangeLocation {
  dir: string;
  archived: boolean;
}

/**
 * Resolves a change name or anchor to its directory: the archive an anchor names exactly,
 * else the active change, else the newest archive of that name. Anything that is not a
 * single change-name segment resolves to nothing.
 */
export async function locateChange(
  companionPath: string,
  target: string,
): Promise<ChangeLocation | null> {
  if (!isChangeName(target)) return null;
  const archiveDir = archiveDirOf(companionPath);
  if (parseAnchor(target) && (await pathIsDirectory(path.join(archiveDir, target)))) {
    return { dir: path.join(archiveDir, target), archived: true };
  }
  const active = path.join(changesDirOf(companionPath), target);
  if (await pathIsDirectory(active)) return { dir: active, archived: false };
  const newest = (await archiveAnchors(companionPath, target)).at(-1);
  return newest ? { dir: path.join(archiveDir, newest), archived: true } : null;
}

export interface DeltaSpec {
  /** POSIX path under the change's `specs/`, e.g. `identity/user-auth/spec.md`. */
  file: string;
  /** The companion-relative canonical path the file maps to. */
  canonical: string;
  /** The capability path of a `spec.md` below `specs/`; null for any other file. */
  capability: string | null;
}

/**
 * Every file below `dir` at any depth, as sorted POSIX paths relative to it. Reads directory
 * entry names only, never contents; an unreadable directory contributes nothing.
 */
export async function filesBelow(dir: string): Promise<string[]> {
  const walk = async (current: string, relative: string): Promise<string[]> => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return [];
    }
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) return walk(path.join(current, entry.name), entryRelative);
        return entry.isFile() ? [entryRelative] : [];
      }),
    );
    return nested.flat();
  };
  return (await walk(dir, "")).toSorted();
}

/**
 * Every file under the change's `specs/`, at any depth, sorted. Reads directory entry
 * names only, never contents. A change without `specs/` has none.
 */
export async function deltaSpecs(changeDir: string): Promise<DeltaSpec[]> {
  const files = await filesBelow(path.join(changeDir, "specs"));
  return files.map((file) => {
    const capability = path.posix.dirname(file);
    return {
      file,
      canonical: `${SPECS_RELATIVE_DIR}/${file}`,
      capability: path.posix.basename(file) === "spec.md" && capability !== "." ? capability : null,
    };
  });
}
