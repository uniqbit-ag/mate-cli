import fs from "node:fs/promises";
import path from "node:path";

import { templateRoot } from "./globs";
import { submitType, type DeclaredArtifactType, type Workflow } from "./workflow";

/**
 * Where a workflow's submit type keeps its change folders, and their names. Only directory
 * names are read. Delivery's change layout builds on this; the session runtime reaches change
 * names only here.
 */

/** Companion-relative POSIX directories of an artifact type's change folders. */
export interface ChangeFolders {
  /** Holds one folder per change. */
  source: string;
  /** Holds one folder per archived record; absent when none is kept. */
  archiveRoot?: string;
}

/** The built-in OpenSpec type's folders. */
export const OPENSPEC_CHANGE_FOLDERS = {
  source: "openspec/changes",
  archiveRoot: "openspec/changes/archive",
} as const satisfies ChangeFolders;

/**
 * One path segment: no separator, NUL, or leading dot (so never `.`, `..`, or hidden).
 * Wider than OpenSpec's kebab-case, so archives made under older rules still resolve.
 */
const SEGMENT = /^[^./\\\0][^/\\\0]*$/;

/** Where declared type `declared` keeps change folders: the template roots of its paths. */
export function declaredChangeFolders(declared: DeclaredArtifactType): ChangeFolders {
  return {
    source: templateRoot(declared.change),
    ...(declared.archive === undefined ? {} : { archiveRoot: templateRoot(declared.archive) }),
  };
}

/** Where `workflow`'s submit type keeps change folders: a declared type's, else `openspec/changes`. */
export function changeFolders(workflow: Workflow): ChangeFolders {
  const declared = submitType(workflow);
  return declared ? declaredChangeFolders(declared) : OPENSPEC_CHANGE_FOLDERS;
}

/** A change folder name of `folders`: one path segment that is not its archive folder. */
export function isChangeFolderName(folders: ChangeFolders, candidate: string): boolean {
  return SEGMENT.test(candidate) && `${folders.source}/${candidate}` !== folders.archiveRoot;
}

/** The change folder names below `root`, sorted; one path segment each, never the archive folder. */
export async function changeFolderNames(root: string, folders: ChangeFolders): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(path.join(root, ...folders.source.split("/")), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isChangeFolderName(folders, entry.name))
    .map((entry) => entry.name)
    .toSorted();
}
