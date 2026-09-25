import fs from "node:fs/promises";
import path from "node:path";

import type { WorkingTreeChange } from "../finish/git";

/** Whether an archived change still has uncommitted content in the companion working tree. */
export type CommitState = "committed" | "uncommitted";

/** An archive whose delta specs name a canonical spec. Evidence, never proof of authorship. */
export interface SpecAttribution {
  /** Dated archive directory name, e.g. `2026-09-07-acme`. */
  anchor: string;
  state: CommitState;
}

/** An uncommitted canonical spec no pending change accounts for, with its attribution. */
export interface UnattributedSpec {
  /** Companion-relative POSIX path of the canonical spec. */
  path: string;
  /** Whether the spec is new or already tracked and modified. */
  kind: WorkingTreeChange;
  /** Every archive naming this spec, oldest anchor first; empty when none does. */
  touchedByArchives: SpecAttribution[];
}

export interface UncommittedSpecChange {
  /** Companion-relative POSIX path of the canonical spec. */
  path: string;
  /** Whether the spec is new or already tracked and modified. */
  kind: WorkingTreeChange;
}

export interface ArchiveEntry {
  /** Change name with the archive date prefix stripped. */
  name: string;
  /** Dated archive directory name, e.g. `2026-09-07-acme`. */
  anchor: string;
  /** Companion-relative POSIX path of the archive directory. */
  path: string;
  /** Tag `mate artifact publish` creates for this anchor. */
  tag: string;
  /** Uncommitted owned directories that make this change pending. */
  uncommittedPaths: string[];
  /** Uncommitted canonical specs this change's delta specs applied to. */
  uncommittedSpecs: string[];
  /** Uncommitted canonical specs with their working-tree change kind. */
  uncommittedSpecChanges: UncommittedSpecChange[];
  state: CommitState;
}

/** Only dated archive directories are publishable; everything else is ignored. */
const ARCHIVE_ANCHOR_PATTERN = /^\d{4}-\d{2}-\d{2}-.+$/;
const ARCHIVE_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

const ARCHIVE_RELATIVE_DIR = "openspec/changes/archive";
export const SPECS_RELATIVE_DIR = "openspec/specs";

/** The tag `mate artifact publish` creates, never a recomputed date. */
export function finishMarker(anchor: string): string {
  return `openspec/${anchor}`;
}

/** Porcelain collapses an untracked directory to `dir/`; compare without that suffix. */
function withoutTrailingSlash(candidate: string): string {
  return candidate.endsWith("/") ? candidate.slice(0, -1) : candidate;
}

/** True when the reported path is the owned path, sits inside it, or collapsed it. */
function touches(worktreePath: string, ownedPath: string): boolean {
  const reported = withoutTrailingSlash(worktreePath);
  return (
    reported === ownedPath ||
    reported.startsWith(`${ownedPath}/`) ||
    ownedPath.startsWith(`${reported}/`)
  );
}

function matching(uncommittedPaths: string[], owned: string[]): string[] {
  return [
    ...new Set(
      uncommittedPaths.filter((worktreePath) =>
        owned.some((ownedPath) => touches(worktreePath, ownedPath)),
      ),
    ),
  ].toSorted();
}

function matchingDirectories(uncommittedPaths: string[], owned: string[]): string[] {
  return owned
    .flatMap((ownedPath) =>
      uncommittedPaths.some((worktreePath) => touches(worktreePath, ownedPath))
        ? [ownedPath.endsWith("/") ? ownedPath : `${ownedPath}/`]
        : [],
    )
    .toSorted();
}

function changeKindFor(
  worktreePath: string,
  kinds: Readonly<Record<string, WorkingTreeChange>>,
): WorkingTreeChange {
  const direct = kinds[worktreePath] ?? kinds[withoutTrailingSlash(worktreePath)];
  if (direct) return direct;

  return (
    Object.entries(kinds).find(([candidate]) =>
      touches(worktreePath, withoutTrailingSlash(candidate)),
    )?.[1] ?? "modified"
  );
}

/**
 * Canonical specs the change's delta specs applied to. Only directory entry names under
 * the archive's `specs/` tree are read — never any file contents — so archived prose
 * cannot influence discovery.
 */
async function canonicalSpecsFor(companionPath: string, anchor: string): Promise<string[]> {
  const collectDeltaSpecFiles = async (directory: string, relative = ""): Promise<string[]> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const entryRelative = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) {
          return collectDeltaSpecFiles(path.join(directory, entry.name), entryRelative);
        }
        return entry.isFile() ? [path.posix.join(SPECS_RELATIVE_DIR, entryRelative)] : [];
      }),
    );
    return nested.flat();
  };
  try {
    const specs = await collectDeltaSpecFiles(
      path.join(companionPath, ARCHIVE_RELATIVE_DIR, anchor, "specs"),
    );
    return specs.toSorted();
  } catch {
    // A change without delta specs still owns its archive and active directories.
    return [];
  }
}

/**
 * Lists every dated archive directory with its commit state. State comes from the paths a
 * change owns outright — its archive directory and the active directory archiving deleted
 * — because canonical specs are shared: a spec today's work modified would otherwise
 * resurrect every long-published change that ever touched it. Owned specs are still
 * reported on a pending entry so the publication scope is visible. Ordering is the stable
 * anchor sort (oldest date first).
 */
export async function discoverArchives(
  companionPath: string,
  uncommittedPaths: string[],
  changeKinds: Readonly<Record<string, WorkingTreeChange>> = {},
): Promise<ArchiveEntry[]> {
  let entries;
  try {
    entries = await fs.readdir(path.join(companionPath, "openspec", "changes", "archive"), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }

  const anchors = entries
    .filter((entry) => entry.isDirectory() && ARCHIVE_ANCHOR_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .toSorted();

  return Promise.all(
    anchors.map(async (anchor) => {
      const name = anchor.replace(ARCHIVE_DATE_PREFIX, "");
      const ownedPaths = [`${ARCHIVE_RELATIVE_DIR}/${anchor}`, `openspec/changes/${name}`];
      const owned = matching(uncommittedPaths, ownedPaths);
      const ownedDirectories = matchingDirectories(uncommittedPaths, ownedPaths);
      const specs =
        owned.length > 0
          ? matching(uncommittedPaths, await canonicalSpecsFor(companionPath, anchor))
          : [];
      const specChanges = specs.map((specPath) => ({
        path: specPath,
        kind: changeKindFor(specPath, changeKinds),
      }));
      return {
        name,
        anchor,
        path: `${ARCHIVE_RELATIVE_DIR}/${anchor}`,
        tag: finishMarker(anchor),
        uncommittedPaths: ownedDirectories,
        uncommittedSpecs: specs,
        uncommittedSpecChanges: specChanges,
        state: (owned.length > 0 ? "uncommitted" : "committed") as CommitState,
      };
    }),
  );
}

export function pendingArchives(archives: ArchiveEntry[]): ArchiveEntry[] {
  return archives.filter((archive) => archive.state === "uncommitted");
}

/**
 * Every archive with the canonical specs its delta specs name, in the caller's archive
 * order. Built once per call and only when something is unattributed, so the common
 * `pending` invocation keeps its current I/O.
 */
async function attributionIndex(
  companionPath: string,
  archives: ArchiveEntry[],
): Promise<Array<SpecAttribution & { specs: string[] }>> {
  return Promise.all(
    archives.map(async (archive) => ({
      anchor: archive.anchor,
      state: archive.state,
      specs: await canonicalSpecsFor(companionPath, archive.anchor),
    })),
  );
}

/**
 * Uncommitted canonical specs that no pending change accounts for, each attributed to
 * every archive whose delta specs name it. An attributed spec belongs to a change whose
 * archive is already committed and can be resumed by publishing that change by name; an
 * unattributed one belongs to work that is not archived yet. `archives` is the full
 * archive list, not just the pending ones, because attribution's whole point is naming
 * the committed archives pending discovery excludes.
 */
export async function unattributedSpecs(
  companionPath: string,
  uncommittedPaths: string[],
  archives: ArchiveEntry[],
  changeKinds: Readonly<Record<string, WorkingTreeChange>> = {},
): Promise<UnattributedSpec[]> {
  const claimed = new Set(pendingArchives(archives).flatMap((entry) => entry.uncommittedSpecs));
  const specPaths = uncommittedPaths
    .filter(
      (worktreePath) => touches(worktreePath, SPECS_RELATIVE_DIR) && !claimed.has(worktreePath),
    )
    .toSorted();
  if (specPaths.length === 0) return [];

  const index = await attributionIndex(companionPath, archives);
  return specPaths.map((specPath) => ({
    path: specPath,
    kind: changeKindFor(specPath, changeKinds),
    touchedByArchives: index.flatMap(({ anchor, state, specs }) =>
      specs.some((spec) => touches(specPath, spec)) ? [{ anchor, state }] : [],
    ),
  }));
}
