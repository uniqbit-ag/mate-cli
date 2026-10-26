import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { FRAMEWORK_NAME } from "../../framework";
import { gitEnvironment } from "../../runtime/companion-git";
import {
  documentRegions,
  readManifest,
  updateManifest,
  withDocument,
  withoutDocuments,
  type ManagedRegion,
  type RenderedRuntimeDocument,
} from "../../runtime/runtime-document-manifest";
import { writeAtomic } from "../../runtime/write-atomic";
import { pruneEmptyAncestors } from "../../tools/setup/utils";

export {
  CLAUDE_LOCAL_CONFIG_DOCUMENT,
  CLAUDE_MCP_DOCUMENT,
  CLAUDE_SETTINGS_DOCUMENT,
  OPENCODE_CONFIG_DOCUMENT,
} from "../../runtime/runtime-document-manifest";

/**
 * Places the documents an Agent Runtime discovers by its own upward walk from
 * the current directory. A Runtime Surface renders one as a value; this module
 * writes it, records the regions it wrote at the Projection Root, and removes
 * exactly those again — which is what makes a working-target document swept by
 * `mate working cleanup` without cleanup holding a list of them. The manifest
 * — format, I/O and queries — belongs to `runtime/runtime-document-manifest`.
 */

/**
 * A document Mate does not own the surroundings of. Mate's regions are stripped
 * from one exactly as from any other, but it is never deleted when emptied and
 * no directory around it is ever pruned — the file is the user's, and everything
 * else in it belongs to Claude Code.
 */
export function isExternalDocument(documentPath: string): boolean {
  return documentPath.startsWith("~/");
}

const execFileAsync = promisify(execFile);

/** Whether Git tracks the repo-relative path; any `ls-files` failure reads as untracked. */
async function gitTracks(repoPath: string, relativePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--", relativePath], {
      cwd: path.resolve(repoPath),
      encoding: "utf8",
      env: gitEnvironment(),
    });
    return stdout.split("\0").includes(relativePath);
  } catch {
    return false;
  }
}

/**
 * Excludes don't hide tracked files, so regions with machine-absolute paths
 * would land in a committed document: warn, still write. Best-effort: any
 * `ls-files` failure reads as "not tracked".
 */
export async function trackedDocumentWarnings(
  repoPath: string,
  documentPath: string,
  repositoryId: string,
): Promise<string[]> {
  if (!(await gitTracks(repoPath, documentPath))) return [];
  return [
    `${documentPath} is tracked by Git in ${repositoryId}; ${FRAMEWORK_NAME} writes machine-absolute companion paths into it, so committing it would push this machine's paths to everyone else on the repository. Untrack it with \`git rm --cached ${documentPath}\` if those paths should stay local.`,
  ];
}

/**
 * Injectable so a test never writes to the real `~/.claude.json`. An external
 * target is the one destination outside a temporary fixture, so it is also the
 * one that has to be overridable for the suite to stay hermetic.
 */
export const runtimeDocumentDeps = {
  homeDir: (): string => os.homedir(),
};

function documentPathIn(repoPath: string, documentPath: string): string {
  if (isExternalDocument(documentPath)) {
    return path.join(runtimeDocumentDeps.homeDir(), ...documentPath.slice("~/".length).split("/"));
  }
  return path.join(path.resolve(repoPath), ...documentPath.split("/"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * `null` means the file is not there, and nothing else does. A read that failed
 * for any other reason — a permission the user revoked, a path that turned out
 * to be a directory — is not an absent document, and answering `null` to one
 * would have the caller write a fresh document over whatever it could not read.
 */
async function readRaw(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Unparseable throws, never reads as empty: writing back a torn
 * `~/.claude.json` would wipe the user's auth and history.
 */
function parseDocument(raw: string | null, target: string): Record<string, unknown> {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${target} is not valid JSON; refusing to rewrite it`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error(`${target} is not a JSON object; refusing to rewrite it`);
  return parsed;
}

/** The container holding a region's final key, created on demand when writing. */
function containerFor(
  document: Record<string, unknown>,
  at: string[],
  create: boolean,
): Record<string, unknown> | null {
  let node = document;
  for (const key of at.slice(0, -1)) {
    const next = node[key];
    if (isRecord(next)) {
      node = next;
      continue;
    }
    if (!create) return null;
    const created: Record<string, unknown> = {};
    node[key] = created;
    node = created;
  }
  return node;
}

function keyPresent(document: Record<string, unknown>, at: string[]): boolean {
  const container = containerFor(document, at, false);
  return container !== null && Object.hasOwn(container, at.at(-1)!);
}

function applyRegion(document: Record<string, unknown>, region: ManagedRegion): void {
  const container = containerFor(document, region.at, true)!;
  const key = region.at.at(-1)!;
  if (region.kind === "value") {
    container[key] = region.value;
    return;
  }
  if (region.kind === "map") {
    const present = isRecord(container[key]);
    const found = present ? (container[key] as Record<string, unknown>) : {};
    /** Keys an older Mate wrote here, dropped before this Mate's own are set. */
    const existing = region.stripPrefix
      ? Object.fromEntries(
          Object.entries(found).filter(([name]) => !name.startsWith(region.stripPrefix!)),
        )
      : found;
    const next = { ...existing, ...region.entries };
    /** A map only stripped is not created, and one stripped bare is not left as `{}`. */
    if (Object.keys(next).length > 0) container[key] = next;
    else if (present && Object.keys(found).length > 0) delete container[key];
    else if (!present) pruneEmptyContainers(document, region.at);
    return;
  }
  const existing = Array.isArray(container[key]) ? (container[key] as unknown[]) : [];
  const seen = new Set(existing.map((entry) => JSON.stringify(entry)));
  container[key] = [
    ...existing,
    ...region.values.filter((value) => !seen.has(JSON.stringify(value))),
  ];
}

/** Removes only what was recorded; a value a human has since changed stays. */
function revertRegion(document: Record<string, unknown>, region: ManagedRegion): void {
  const container = containerFor(document, region.at, false);
  if (!container) return;
  const key = region.at.at(-1)!;

  if (region.kind === "value") {
    if (JSON.stringify(container[key]) === JSON.stringify(region.value)) delete container[key];
  } else if (region.kind === "map") {
    const existing = isRecord(container[key])
      ? { ...(container[key] as Record<string, unknown>) }
      : null;
    if (existing) {
      for (const [name, entry] of Object.entries(region.entries)) {
        if (JSON.stringify(existing[name]) === JSON.stringify(entry)) delete existing[name];
      }
      if (Object.keys(existing).length > 0) container[key] = existing;
      else delete container[key];
    }
  } else {
    const existing = Array.isArray(container[key]) ? (container[key] as unknown[]) : null;
    if (existing) {
      const removed = new Set(region.values.map((value) => JSON.stringify(value)));
      const remaining = existing.filter((entry) => !removed.has(JSON.stringify(entry)));
      if (remaining.length > 0) container[key] = remaining;
      else delete container[key];
    }
  }

  pruneEmptyContainers(document, region.at);
}

/** An emptied container Mate created is not left behind as `{}`. */
function pruneEmptyContainers(document: Record<string, unknown>, at: string[]): void {
  for (let depth = at.length - 1; depth > 0; depth -= 1) {
    const parent = containerFor(document, at.slice(0, depth), false);
    const parentKey = at[depth - 1];
    const node = parent?.[parentKey];
    if (parent && isRecord(node) && Object.keys(node).length === 0) delete parent[parentKey];
  }
}

/**
 * Writes the document's managed regions into whatever is already there, and
 * records them. An unchanged document is not rewritten, so `current` means
 * untouched — which is what makes a second wrap modify no file.
 *
 * What the last wrap recorded comes back out before this wrap's regions go in,
 * because placing is a reconciliation and not an append. `applyRegion` adds a
 * list value only when it is not already there, so a value that has since
 * changed — a bumped plugin version, a plugin root that moved — would otherwise
 * settle in beside its predecessor, and the predecessor is no longer in the
 * manifest for `removeRuntimeDocument` to reach. Reverting first is value-
 * guarded, so what a human has edited since is not Mate's to take back and
 * survives the round-trip as theirs.
 *
 * A render that no longer produces this destination withdraws it. `document()`
 * drops empty regions and returns nothing when none are left, so a document
 * whose last capability was disabled simply stops being rendered — and without
 * the withdrawal below the entries the previous wrap wrote would stay live
 * forever, a disabled MCP server still declared in the user's `~/.claude.json`.
 * The withdrawal is the same one `unproject` performs, and it reaches only the
 * one destination this call names, so a scope that projects a smaller set of
 * documents can never take back a document it was not asked about.
 */
export async function placeRuntimeDocument(
  repoPath: string,
  documentPath: string,
  documents?: readonly RenderedRuntimeDocument[],
): Promise<"written" | "current" | "skipped"> {
  /**
   * No render at all is not an empty render: a scope that supplies no documents
   * — a launch, which projects this entry without rendering for it — is claiming
   * nothing about this destination and must leave what a wrap recorded alone.
   */
  if (!documents) return "skipped";

  const rendered = documents.find((candidate) => candidate.path === documentPath);
  if (!rendered) {
    return (await removeRuntimeDocument(repoPath, documentPath)) === "removed"
      ? "written"
      : "current";
  }

  const target = documentPathIn(repoPath, documentPath);
  const raw = await readRaw(target);
  const document = parseDocument(raw, target);

  const prior = documentRegions(await readManifest(repoPath), documentPath);
  for (const region of prior ?? []) revertRegion(document, region);
  /** After the revert, a key still present is the human's: a yielding region gives way to it. */
  const applied = rendered.regions.filter(
    (region) => !(region.kind === "value" && region.yields && keyPresent(document, region.at)),
  );
  for (const region of applied) applyRegion(document, region);
  const next = serialize(document);

  const recorded = JSON.stringify(prior) === JSON.stringify(applied);
  if (next === raw && recorded) return "current";

  /** The file first: a failed write leaves the manifest naming what is really there. */
  await fs.mkdir(path.dirname(target), { recursive: true });
  await writeAtomic(target, next);
  await updateManifest(repoPath, (manifest) => withDocument(manifest, documentPath, applied));
  return "written";
}

/**
 * Strips the recorded regions and leaves the document Mate found; a document
 * left empty is deleted along with any directory Mate created to hold it.
 */
export async function removeRuntimeDocument(
  repoPath: string,
  documentPath: string,
): Promise<"removed" | "absent"> {
  const regions = documentRegions(await readManifest(repoPath), documentPath);
  if (!regions) return "absent";

  await revertDocumentOnDisk(repoPath, documentPath, regions);
  await updateManifest(repoPath, (manifest) => withoutDocuments(manifest, [documentPath]));
  return "removed";
}

/**
 * One document's regions, taken back out of the file that holds them. Knows
 * nothing of the manifest, which is what lets several destinations be reverted
 * at once: every document is a distinct file, while the manifest recording them
 * all is not.
 */
async function revertDocumentOnDisk(
  repoPath: string,
  documentPath: string,
  regions: readonly ManagedRegion[],
): Promise<void> {
  const target = documentPathIn(repoPath, documentPath);
  const raw = await readRaw(target);
  if (raw === null) return;

  const document = parseDocument(raw, target);
  for (const region of regions) revertRegion(document, region);
  if (Object.keys(document).length === 0 && !isExternalDocument(documentPath)) {
    await fs.unlink(target);
    const holder = path.dirname(target);
    if (holder !== path.resolve(repoPath)) {
      await pruneEmptyAncestors(holder, path.resolve(repoPath));
    }
  } else {
    await writeAtomic(target, serialize(document));
  }
}

/**
 * Withdraws several destinations against a single manifest update.
 * `removeRuntimeDocument` per destination cannot be run concurrently — each
 * rewrites the whole manifest, so the last write restores the keys the others
 * removed — and running it sequentially rewrites the manifest once per
 * document. Reverting the files together and recording the outcome once is both
 * safe and one write.
 *
 * A document that throws keeps its manifest entry, so the record still names
 * what is left behind, and the destinations that did succeed are still
 * withdrawn. The first error is returned rather than raised: unwrapping reports
 * per document, and a rejected batch would lose which one failed.
 */
export async function removeRuntimeDocuments(
  repoPath: string,
  documentPaths: readonly string[],
): Promise<{ removed: string[]; absent: string[]; error?: { document: string; error: Error } }> {
  const manifest = await readManifest(repoPath);
  const recorded = documentPaths.filter((candidate) => documentRegions(manifest, candidate));
  const absent = documentPaths.filter((candidate) => !documentRegions(manifest, candidate));
  if (recorded.length === 0) return { removed: [], absent };

  const settled = await Promise.allSettled(
    recorded.map((documentPath) =>
      revertDocumentOnDisk(repoPath, documentPath, documentRegions(manifest, documentPath)!),
    ),
  );

  const removed: string[] = [];
  let failure: { document: string; error: Error } | undefined;
  for (const [index, result] of settled.entries()) {
    const documentPath = recorded[index]!;
    if (result.status === "rejected") {
      failure ??= {
        document: documentPath,
        error: result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
      };
      continue;
    }
    removed.push(documentPath);
  }

  await updateManifest(repoPath, (current) => withoutDocuments(current, removed));
  return { removed, absent, ...(failure ? { error: failure } : {}) };
}
