import crypto from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  copies,
  readManifest,
  updateManifest,
  withCopies,
  type CopyRecord,
} from "../../runtime/runtime-document-manifest";
import { writeAtomic } from "../../runtime/write-atomic";
import { pruneEmptyAncestors } from "../../tools/setup/utils";
import { reconcileWorkingRepoCopyExcludes } from "../../tools/setup/working-repo-local-state";
import {
  excludeRemovalReport,
  type ProjectionSelfRemoval,
  type ProjectionWriteReport,
} from "./projection-types";

/**
 * Copies the companion's `.opencode/` into the Working Repository's own
 * `.opencode/`, the one slot OpenCode reads beside the user's global config.
 * Regular files, not links: OpenCode does not live-reload a linked folder.
 * Mate touches only the files its manifest records as owned.
 */

const OPENCODE_DIR = ".opencode";
/** `opencode.json` is merged into the wrapped document instead of copied. */
const SKIPPED_TOP_LEVEL = new Set(["opencode.json"]);
const SKIPPED_NAMES = new Set(["node_modules", ".DS_Store"]);

interface CopySource {
  absolute: string;
  content: Buffer;
  sha256: string;
}

function sha256(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function walk(dir: string, relative: string, into: Map<string, CopySource>): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (SKIPPED_NAMES.has(entry.name)) continue;
    if (relative === "" && SKIPPED_TOP_LEVEL.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    // oxlint-disable-next-line no-await-in-loop -- sequential walk keeps the order stable
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) {
      // oxlint-disable-next-line no-await-in-loop
      await walk(absolute, rel, into);
      continue;
    }
    if (!stat.isFile()) continue;
    // oxlint-disable-next-line no-await-in-loop
    const content = await fs.readFile(absolute);
    into.set(`${OPENCODE_DIR}/${rel}`, { absolute, content, sha256: sha256(content) });
  }
}

async function companionSources(companionPath: string): Promise<Map<string, CopySource>> {
  const sources = new Map<string, CopySource>();
  await walk(path.join(companionPath, OPENCODE_DIR), "", sources);
  return sources;
}

function destination(repoPath: string, relativePath: string): string {
  return path.join(path.resolve(repoPath), ...relativePath.split("/"));
}

/** `null` when absent; a directory or other non-file reads as a foreign entry. */
async function readDestination(target: string): Promise<Buffer | "foreign" | null> {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return null;
  if (!stat.isFile()) return "foreign";
  return fs.readFile(target);
}

async function writeCopy(target: string, content: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await writeAtomic(target, content);
}

async function deleteCopy(repoPath: string, relativePath: string): Promise<void> {
  const target = destination(repoPath, relativePath);
  await fs.rm(target, { force: true });
  await pruneEmptyAncestors(path.dirname(target), path.resolve(repoPath));
}

interface CopyPlan {
  write: Array<{ relativePath: string; source: CopySource; warning?: string }>;
  remove: string[];
  shadowed: Array<{ relativePath: string; source: CopySource }>;
  records: Record<string, CopyRecord>;
  previous: Record<string, CopyRecord>;
}

async function planCopies(repoPath: string, companionPath: string): Promise<CopyPlan> {
  const previous = copies(await readManifest(repoPath), "opencode");
  const sources = await companionSources(companionPath);
  const plan: CopyPlan = { write: [], remove: [], shadowed: [], records: {}, previous };

  for (const [relativePath, source] of sources) {
    const owned = previous[relativePath];
    // oxlint-disable-next-line no-await-in-loop -- one stat per file
    const current = await readDestination(destination(repoPath, relativePath));
    if (current === "foreign" || (!owned && current !== null)) {
      plan.shadowed.push({ relativePath, source });
      continue;
    }
    const currentSha = current === null ? null : sha256(current);
    const edited = owned !== undefined && currentSha !== null && currentSha !== owned.sha256;
    /** Local edit survives until its companion source changes. */
    const keepEdit = edited && source.sha256 === owned.sha256;
    if (currentSha !== source.sha256 && !keepEdit) {
      plan.write.push({
        relativePath,
        source,
        warning: edited
          ? `${relativePath} was edited locally; the edit was replaced from the companion. Edit ${source.absolute} instead.`
          : undefined,
      });
    }
    plan.records[relativePath] = { runtime: "opencode", sha256: source.sha256 };
  }
  for (const relativePath of Object.keys(previous)) {
    if (!sources.has(relativePath)) plan.remove.push(relativePath);
  }
  return plan;
}

/** The copies a Checkout records; another Checkout's keep their lines in the shared file. */
async function recordedCopiesOf(checkout: string): Promise<string[]> {
  return Object.keys(copies(await readManifest(checkout), "opencode"));
}

function sameRecords(a: Record<string, CopyRecord>, b: Record<string, CopyRecord>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function shadowWarning(relativePath: string, source: CopySource): string {
  return `${relativePath} in the working repository shadows the companion file ${source.absolute}; the repository file wins.`;
}

/**
 * Adds, updates and deletes owned copies; an unowned path is never touched.
 * Excludes widen and new paths are recorded before any write, so an
 * interrupted reconcile leaves no unrecorded copy and none Git would list.
 */
export async function reconcileCompanionCopies(
  repoPath: string,
  companionPath: string,
): Promise<ProjectionWriteReport> {
  const plan = await planCopies(repoPath, companionPath);
  const warnings = plan.shadowed.map(({ relativePath, source }) =>
    shadowWarning(relativePath, source),
  );

  const covering = [...new Set([...Object.keys(plan.previous), ...Object.keys(plan.records)])];
  const excludesWidened = (
    await reconcileWorkingRepoCopyExcludes(repoPath, covering, recordedCopiesOf)
  ).changed;
  /** Previous records win: a path not yet rewritten keeps the hash on disk. */
  const interim = { ...plan.records, ...plan.previous };
  if (!sameRecords(interim, plan.previous)) {
    await updateManifest(repoPath, (manifest) => withCopies(manifest, "opencode", interim));
  }

  for (const { relativePath, source, warning } of plan.write) {
    // oxlint-disable-next-line no-await-in-loop -- bounded by the companion folder
    await writeCopy(destination(repoPath, relativePath), source.content);
    if (warning) warnings.push(warning);
  }
  for (const relativePath of plan.remove) {
    // oxlint-disable-next-line no-await-in-loop
    await deleteCopy(repoPath, relativePath);
  }

  const recordsWritten = !sameRecords(plan.records, plan.previous);
  if (recordsWritten) {
    await updateManifest(repoPath, (manifest) => withCopies(manifest, "opencode", plan.records));
  }
  const excludesNarrowed = (
    await reconcileWorkingRepoCopyExcludes(repoPath, Object.keys(plan.records), recordedCopiesOf)
  ).changed;

  const written = plan.write.map(({ relativePath }) => relativePath);
  return {
    state:
      written.length > 0 ||
      plan.remove.length > 0 ||
      recordsWritten ||
      excludesWidened ||
      excludesNarrowed
        ? "written"
        : "current",
    warnings,
    changed: { written, removed: plan.remove },
  };
}

/**
 * Deletes every owned copy, then its exclude line unless another Checkout
 * records that copy, and prunes what that emptied: a copy is never on disk
 * without the line that hides it.
 */
async function withdraw(repoPath: string) {
  const owned = await recordedCopiesOf(repoPath);
  for (const relativePath of owned) {
    // oxlint-disable-next-line no-await-in-loop
    await deleteCopy(repoPath, relativePath);
  }
  if (owned.length > 0) {
    await updateManifest(repoPath, (manifest) => withCopies(manifest, "opencode", {}));
  }
  const excludes = await reconcileWorkingRepoCopyExcludes(repoPath, [], recordedCopiesOf);
  /** Deleted copies count as a change too: kept lines make a removal `retained` only when nothing else went. */
  return { ...excludes, owned, changed: owned.length > 0 || excludes.changed };
}

export async function withdrawCompanionCopies(repoPath: string): Promise<ProjectionWriteReport> {
  const { owned, changed } = await withdraw(repoPath);
  return {
    state: changed ? "written" : "current",
    changed: { written: [], removed: owned },
  };
}

export async function removeCompanionCopies(repoPath: string): Promise<ProjectionSelfRemoval> {
  return excludeRemovalReport(await withdraw(repoPath));
}

/** Whether any owned copy is recorded. */
export async function companionCopiesPresent(repoPath: string): Promise<boolean> {
  return (await recordedCopiesOf(repoPath)).length > 0;
}
