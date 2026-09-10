import fs from "node:fs/promises";
import path from "node:path";

/** Whether an archived change already carries its local finish marker. */
export type PublicationState = "published" | "unpublished";

export interface ArchiveEntry {
  /** Change name with the archive date prefix stripped. */
  name: string;
  /** Dated archive directory name, e.g. `2026-09-07-acme`. */
  anchor: string;
  /** Companion-relative POSIX path of the archive directory. */
  path: string;
  /** Local finish marker the finish engine creates for this anchor. */
  tag: string;
  state: PublicationState;
}

/** Only dated archive directories are publishable; everything else is ignored. */
const ARCHIVE_ANCHOR_PATTERN = /^\d{4}-\d{2}-\d{2}-.+$/;
const ARCHIVE_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

export const ARCHIVE_RELATIVE_DIR = "openspec/changes/archive";

/** The finish marker is the tag `mate artifact publish` creates, never a recomputed date. */
export function finishMarker(anchor: string): string {
  return `openspec/${anchor}`;
}

/**
 * Lists every dated archive directory with its publication state. Archive contents are
 * never read: state comes from the local finish marker alone, so archived prose cannot
 * influence discovery. Ordering is the stable anchor sort (oldest date first).
 */
export async function discoverArchives(
  companionPath: string,
  tagExists: (name: string) => Promise<boolean>,
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
      const tag = finishMarker(anchor);
      return {
        name: anchor.replace(ARCHIVE_DATE_PREFIX, ""),
        anchor,
        path: `${ARCHIVE_RELATIVE_DIR}/${anchor}`,
        tag,
        state: ((await tagExists(tag)) ? "published" : "unpublished") as PublicationState,
      };
    }),
  );
}

export function pendingArchives(archives: ArchiveEntry[]): ArchiveEntry[] {
  return archives.filter((archive) => archive.state === "unpublished");
}
