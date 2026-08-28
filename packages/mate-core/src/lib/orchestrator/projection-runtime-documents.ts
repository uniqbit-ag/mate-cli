import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { repoLocalDirPath } from "../../runtime/repo-local";
import { pruneEmptyAncestors } from "../../tools/setup/utils";
import type { ManagedRegion, RenderedRuntimeDocument } from "./projection-types";

/**
 * Places the documents an Agent Runtime discovers by its own upward walk from
 * the current directory. A Runtime Surface renders one as a value; this module
 * writes it, records the regions it wrote at the Projection Root, and removes
 * exactly those again — which is what makes a working-target document swept by
 * `mate working cleanup` without cleanup holding a list of them.
 */

const MANIFEST_FILE = "runtime-documents.json";

/**
 * The three destinations, repo-relative with POSIX separators. Declared here
 * rather than beside the renderers so the entry catalogue names a destination
 * without reaching into an Agent Runtime's Runtime Surface.
 */
export const CLAUDE_SETTINGS_DOCUMENT = ".claude/settings.local.json";
export const CLAUDE_MCP_DOCUMENT = ".mcp.json";
export const OPENCODE_CONFIG_DOCUMENT = ".opencode/opencode.json";

/**
 * The one destination outside the Working Repository. Claude Code has no
 * project file that declares a pre-approved MCP server: `.mcp.json` servers sit
 * "pending approval" until a human accepts them in a session, and the settings
 * document can only enable a server `.mcp.json` already declares. Local scope —
 * `projects[<repo>].mcpServers` in the user's `~/.claude.json`, what
 * `claude mcp add --scope local` writes — is the only channel that is live on
 * first use.
 *
 * Written `~`-prefixed rather than resolved so the manifest recording it stays
 * machine-independent, and so an external target is identifiable as one.
 */
export const CLAUDE_LOCAL_CONFIG_DOCUMENT = "~/.claude.json";

/**
 * A document Mate does not own the surroundings of. Mate's regions are stripped
 * from one exactly as from any other, but it is never deleted when emptied and
 * no directory around it is ever pruned — the file is the user's, and everything
 * else in it belongs to Claude Code.
 */
export function isExternalDocument(documentPath: string): boolean {
  return documentPath.startsWith("~/");
}

/**
 * Injectable so a test never writes to the real `~/.claude.json`. An external
 * target is the one destination outside a temporary fixture, so it is also the
 * one that has to be overridable for the suite to stay hermetic.
 */
export const runtimeDocumentDeps = {
  homeDir: (): string => os.homedir(),
};

interface Manifest {
  documents: Record<string, ManagedRegion[]>;
}

function manifestPath(repoPath: string): string {
  return path.join(repoLocalDirPath(repoPath), MANIFEST_FILE);
}

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

function parseObject(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    /* unparseable — start from an empty object */
  }
  return {};
}

/**
 * The same read for a document Mate does not own, where an unparseable one is
 * refused rather than treated as empty. `parseObject`'s fallback is right for
 * the manifest — Mate wrote it and can rebuild it — and ruinous here: a torn
 * read of `~/.claude.json` would be written back as the handful of keys Mate
 * contributes, taking Claude Code's auth, every project's history and its MCP
 * approvals with it, silently and without a backup. Throwing leaves the file
 * as it was and hands the entry catch in `project()` a failed outcome to
 * report, which is the answer an operator can act on.
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

/**
 * Writes via a sibling temp file + `fs.rename()` so an interrupted write cannot
 * leave a half-written document behind. A reader racing this one — a Claude
 * Code session holding `~/.claude.json` open — observes the old file or the new
 * one, never a truncated one.
 */
async function writeAtomic(target: string, contents: string): Promise<void> {
  const tempPath = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, contents, "utf8");
    await fs.rename(tempPath, target);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function readManifest(repoPath: string): Promise<Manifest> {
  const parsed = parseObject(await readRaw(manifestPath(repoPath)));
  return {
    documents: isRecord(parsed.documents) ? (parsed.documents as Manifest["documents"]) : {},
  };
}

async function writeManifest(repoPath: string, manifest: Manifest): Promise<void> {
  const target = manifestPath(repoPath);
  if (Object.keys(manifest.documents).length === 0) {
    await fs.unlink(target).catch(() => {});
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await writeAtomic(target, serialize(manifest));
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

function applyRegion(document: Record<string, unknown>, region: ManagedRegion): void {
  const container = containerFor(document, region.at, true)!;
  const key = region.at.at(-1)!;
  if (region.kind === "value") {
    container[key] = region.value;
    return;
  }
  if (region.kind === "map") {
    const found = isRecord(container[key]) ? (container[key] as Record<string, unknown>) : {};
    /** Keys an older Mate wrote here, dropped before this Mate's own are set. */
    const existing = region.stripPrefix
      ? Object.fromEntries(
          Object.entries(found).filter(([name]) => !name.startsWith(region.stripPrefix!)),
        )
      : found;
    container[key] = { ...existing, ...region.entries };
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

  /** An emptied container Mate created is not left behind as `{}`. */
  for (let depth = region.at.length - 1; depth > 0; depth -= 1) {
    const parent = containerFor(document, region.at.slice(0, depth), false);
    const parentKey = region.at[depth - 1];
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

  const manifest = await readManifest(repoPath);
  for (const region of manifest.documents[documentPath] ?? []) revertRegion(document, region);
  for (const region of rendered.regions) applyRegion(document, region);
  const next = serialize(document);

  const regions = [...rendered.regions] as ManagedRegion[];
  const recorded = JSON.stringify(manifest.documents[documentPath]) === JSON.stringify(regions);
  if (next === raw && recorded) return "current";

  await fs.mkdir(path.dirname(target), { recursive: true });
  await writeAtomic(target, next);
  manifest.documents[documentPath] = regions;
  await writeManifest(repoPath, manifest);
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
  const manifest = await readManifest(repoPath);
  const regions = manifest.documents[documentPath];
  if (!regions) return "absent";

  await revertDocumentOnDisk(repoPath, documentPath, regions);
  delete manifest.documents[documentPath];
  await writeManifest(repoPath, manifest);
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
 * Withdraws several destinations against a single read and a single write of the
 * manifest. `removeRuntimeDocument` per destination cannot be run concurrently —
 * each rewrites the whole manifest, so the last write restores the keys the
 * others removed — and running it sequentially rewrites the manifest once per
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
  const recorded = documentPaths.filter((candidate) => manifest.documents[candidate] !== undefined);
  const absent = documentPaths.filter((candidate) => manifest.documents[candidate] === undefined);
  if (recorded.length === 0) return { removed: [], absent };

  const settled = await Promise.allSettled(
    recorded.map((documentPath) =>
      revertDocumentOnDisk(repoPath, documentPath, manifest.documents[documentPath]!),
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
    delete manifest.documents[documentPath];
    removed.push(documentPath);
  }

  await writeManifest(repoPath, manifest);
  return { removed, absent, ...(failure ? { error: failure } : {}) };
}

/**
 * Every destination the manifest records, in the order it recorded them. This
 * is what makes a Working Repository "wrapped": the manifest is written only by
 * a pass that placed a runtime document, and `mate wrap` is the only pass that
 * places one. Reported as data so neither the launch refusal nor `mate unwrap`
 * holds a list of destinations that the entry catalogue could outgrow.
 */
export async function recordedRuntimeDocuments(repoPath: string): Promise<string[]> {
  return Object.keys((await readManifest(repoPath)).documents);
}

/** Present when Mate recorded regions for it, not merely when the file exists. */
export async function runtimeDocumentPresent(
  repoPath: string,
  documentPath: string,
): Promise<boolean> {
  return (await readManifest(repoPath)).documents[documentPath] !== undefined;
}
