import fs from "node:fs/promises";
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

interface Manifest {
  documents: Record<string, ManagedRegion[]>;
}

function manifestPath(repoPath: string): string {
  return path.join(repoLocalDirPath(repoPath), MANIFEST_FILE);
}

function documentPathIn(repoPath: string, documentPath: string): string {
  return path.join(path.resolve(repoPath), ...documentPath.split("/"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readRaw(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
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
  await fs.writeFile(target, serialize(manifest), "utf8");
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
    const existing = isRecord(container[key]) ? (container[key] as Record<string, unknown>) : {};
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
 */
export async function placeRuntimeDocument(
  repoPath: string,
  documentPath: string,
  documents: readonly RenderedRuntimeDocument[] = [],
): Promise<"written" | "current" | "skipped"> {
  const rendered = documents.find((candidate) => candidate.path === documentPath);
  if (!rendered) return "skipped";

  const target = documentPathIn(repoPath, documentPath);
  const raw = await readRaw(target);
  const document = parseObject(raw);
  for (const region of rendered.regions) applyRegion(document, region);
  const next = serialize(document);

  const manifest = await readManifest(repoPath);
  const regions = [...rendered.regions] as ManagedRegion[];
  const recorded = JSON.stringify(manifest.documents[documentPath]) === JSON.stringify(regions);
  if (next === raw && recorded) return "current";

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, next, "utf8");
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

  const target = documentPathIn(repoPath, documentPath);
  const raw = await readRaw(target);
  if (raw !== null) {
    const document = parseObject(raw);
    for (const region of regions) revertRegion(document, region);
    if (Object.keys(document).length === 0) {
      await fs.unlink(target);
      const holder = path.dirname(target);
      if (holder !== path.resolve(repoPath)) {
        await pruneEmptyAncestors(holder, path.resolve(repoPath));
      }
    } else {
      await fs.writeFile(target, serialize(document), "utf8");
    }
  }

  delete manifest.documents[documentPath];
  await writeManifest(repoPath, manifest);
  return "removed";
}

/** Present when Mate recorded regions for it, not merely when the file exists. */
export async function runtimeDocumentPresent(
  repoPath: string,
  documentPath: string,
): Promise<boolean> {
  return (await readManifest(repoPath)).documents[documentPath] !== undefined;
}
