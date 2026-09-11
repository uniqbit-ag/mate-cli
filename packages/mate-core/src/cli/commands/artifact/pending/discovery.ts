import fs from "node:fs/promises";
import path from "node:path";

/** Whether an archived change still has uncommitted content in the companion working tree. */
export type CommitState = "committed" | "uncommitted";

export interface ArchiveEntry {
  /** Change name with the archive date prefix stripped. */
  name: string;
  /** Dated archive directory name, e.g. `2026-09-07-acme`. */
  anchor: string;
  /** Companion-relative POSIX path of the archive directory. */
  path: string;
  /** Tag `mate artifact publish` creates for this anchor. */
  tag: string;
  /** Uncommitted paths this change owns outright: its archive and active directories. */
  uncommittedPaths: string[];
  /** Uncommitted canonical specs this change's delta specs applied to. */
  uncommittedSpecs: string[];
  state: CommitState;
}

/** Only dated archive directories are publishable; everything else is ignored. */
const ARCHIVE_ANCHOR_PATTERN = /^\d{4}-\d{2}-\d{2}-.+$/;
const ARCHIVE_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

export const ARCHIVE_RELATIVE_DIR = "openspec/changes/archive";
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
      const owned = matching(uncommittedPaths, [
        `${ARCHIVE_RELATIVE_DIR}/${anchor}`,
        `openspec/changes/${name}`,
      ]);
      const specs =
        owned.length > 0
          ? matching(uncommittedPaths, await canonicalSpecsFor(companionPath, anchor))
          : [];
      return {
        name,
        anchor,
        path: `${ARCHIVE_RELATIVE_DIR}/${anchor}`,
        tag: finishMarker(anchor),
        uncommittedPaths: owned,
        uncommittedSpecs: specs,
        state: (owned.length > 0 ? "uncommitted" : "committed") as CommitState,
      };
    }),
  );
}

export function pendingArchives(archives: ArchiveEntry[]): ArchiveEntry[] {
  return archives.filter((archive) => archive.state === "uncommitted");
}

/**
 * Uncommitted canonical specs that no pending change accounts for. They belong to work
 * that is not yet archived, or to a change whose archive is already committed, so they
 * are surfaced separately rather than silently dropped.
 */
export function unattributedSpecs(uncommittedPaths: string[], pending: ArchiveEntry[]): string[] {
  const claimed = new Set(pending.flatMap((entry) => entry.uncommittedSpecs));
  return uncommittedPaths
    .filter(
      (worktreePath) => touches(worktreePath, SPECS_RELATIVE_DIR) && !claimed.has(worktreePath),
    )
    .toSorted();
}
