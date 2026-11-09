import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "./framework";
import { gitTracksSync } from "./git-tracked";
import { repoLocalDirName, repoLocalDirPath } from "./repo-local";
import { writeAtomic } from "./write-atomic";

/**
 * Runtime document manifest at the Projection Root; sole owner of its format.
 * Pure queries plus a thin I/O shell; readers go through Wrap State (`./wrap-state`).
 */

const RUNTIME_DOCUMENT_MANIFEST_FILE = "runtime-documents.json";

/** Destinations, repo-relative POSIX. Here so the plugin needn't load the projection owner. */
export const CLAUDE_SETTINGS_DOCUMENT = ".claude/settings.local.json";
export const CLAUDE_MCP_DOCUMENT = ".mcp.json";
export const OPENCODE_CONFIG_DOCUMENT = ".opencode/opencode.json";

/**
 * Only destination outside the repo: local-scope `projects[<repo>].mcpServers`
 * is the sole channel live on first use (`.mcp.json` servers await approval).
 * `~`-prefixed so the manifest stays machine-independent.
 */
export const CLAUDE_LOCAL_CONFIG_DOCUMENT = "~/.claude.json";

/**
 * The closed set of documents a wrap places. A manifest naming any other is
 * ignored at parse, and a surface rendering one fails to compile.
 */
export const RUNTIME_DOCUMENTS = [
  CLAUDE_SETTINGS_DOCUMENT,
  CLAUDE_LOCAL_CONFIG_DOCUMENT,
  OPENCODE_CONFIG_DOCUMENT,
] as const;
export type RuntimeDocumentPath = (typeof RUNTIME_DOCUMENTS)[number];

/** Recorded by earlier releases; only ever withdrawn. */
export const LEGACY_RUNTIME_DOCUMENTS = [CLAUDE_MCP_DOCUMENT] as const;

/** Where in {@link OPENCODE_CONFIG_DOCUMENT} the wrap renders its MCP servers. */
export const OPENCODE_MCP_SERVERS_AT: readonly string[] = Object.freeze(["mcp", "servers"]);

/** The Agent Runtimes a wrap places documents or copies for. */
export type WrapRuntime = "claude" | "opencode";

/**
 * A Mate-maintained region, recorded (JSON has no comments): `list` appends,
 * `map` sets by key, `value` sets one key; removal takes back exactly those.
 * `stripPrefix` also deletes matching keys Mate didn't write, never restored.
 * A yielding `value` gives way to an existing key at placement. Only applied
 * regions are recorded.
 */
export type ManagedRegion =
  | { readonly at: string[]; readonly kind: "list"; readonly values: unknown[] }
  | {
      readonly at: string[];
      readonly kind: "map";
      readonly entries: Record<string, unknown>;
      readonly stripPrefix?: string;
    }
  | {
      readonly at: string[];
      readonly kind: "value";
      readonly value: unknown;
      /** Applied only when the key is absent once the prior pass is withdrawn. */
      readonly yields?: true;
    };

/**
 * What a Runtime Surface hands the Projection Root: the managed content of one
 * document, without a destination. The surface renders; the entry places.
 */
export interface RenderedRuntimeDocument {
  readonly path: RuntimeDocumentPath;
  readonly regions: readonly ManagedRegion[];
}

/** What a working-target render returns: its warnings are data for the caller, never printed. */
export interface RenderedRuntimeDocuments {
  documents: RenderedRuntimeDocument[];
  warnings: string[];
}

function nonEmpty(region: ManagedRegion): boolean {
  if (region.kind === "list") return region.values.length > 0;
  /** A stripping map still heals what an older Mate left, with no entry of its own. */
  if (region.kind === "map") {
    return Object.keys(region.entries).length > 0 || region.stripPrefix !== undefined;
  }
  return true;
}

/** One rendered document of its non-empty regions, or none when every region is empty. */
export function renderedDocument(
  documentPath: RuntimeDocumentPath,
  regions: ManagedRegion[],
): RenderedRuntimeDocument[] {
  const kept = regions.filter(nonEmpty);
  return kept.length > 0 ? [{ path: documentPath, regions: kept }] : [];
}

/** An owned companion copy: the hash of what Mate last wrote there. */
export interface CopyRecord {
  runtime: WrapRuntime;
  sha256: string;
}

/** A link Mate created; `target` is absolute, so a repointed link no longer matches. */
export interface LinkRecord {
  runtime: WrapRuntime;
  target: string;
}

/** `runtimes` sits beside `documents` so `documents` keeps its region-array shape. */
export interface Manifest {
  readonly documents: Readonly<Record<string, ManagedRegion[]>>;
  readonly runtimes: Readonly<Record<string, WrapRuntime>>;
  readonly copies: Readonly<Record<string, CopyRecord>>;
  readonly links: Readonly<Record<string, LinkRecord>>;
}

export const EMPTY_MANIFEST: Manifest = Object.freeze({
  documents: Object.freeze({}),
  runtimes: Object.freeze({}),
  copies: Object.freeze({}),
  links: Object.freeze({}),
});

/** Legacy manifests carry no tag; every destination Mate ever wrote is runtime-specific by path. */
export function documentRuntime(documentPath: string): WrapRuntime {
  return documentPath.startsWith(".opencode/") ? "opencode" : "claude";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A manifest confined to the closed destination set, and the records it dropped. */
export interface ConfinedManifest {
  manifest: Manifest;
  /** Each dropped key, or `<document> region at <address>`, as recorded. */
  rejected: string[];
}

const NO_REJECTIONS: ConfinedManifest = Object.freeze({ manifest: EMPTY_MANIFEST, rejected: [] });

/**
 * Never throws: an absent, unparseable or foreign manifest reads as empty — Mate can rebuild it.
 * `repoRoot` pins the one `~/.claude.json` region this repository may record.
 */
export function parseManifest(raw: string | null, repoRoot: string): Manifest {
  return confineManifest(raw, repoRoot).manifest;
}

/** {@link parseManifest}, also reporting what confinement dropped. */
export function confineManifest(raw: string | null, repoRoot: string): ConfinedManifest {
  if (raw === null) return NO_REJECTIONS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return NO_REJECTIONS;
  }
  return isRecord(parsed) ? manifestOf(parsed, repoRoot) : NO_REJECTIONS;
}

/** For readers that rewrite on its strength: a manifest present but unparseable throws. */
export function parseManifestStrict(raw: string | null, repoRoot: string): Manifest {
  if (raw === null) return EMPTY_MANIFEST;
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error("runtime document manifest is not a JSON object");
  return manifestOf(parsed, repoRoot).manifest;
}

const PLACED_DOCUMENTS: ReadonlySet<string> = new Set([
  ...RUNTIME_DOCUMENTS,
  ...LEGACY_RUNTIME_DOCUMENTS,
]);
const OPENCODE_COPY_PREFIX = ".opencode/";
const UNCOPIED_SEGMENTS: ReadonlySet<string> = new Set(["node_modules", ".DS_Store"]);
const LINK_KEY = /^\.claude\/(?:skills|commands)\/([^/]*)$/;

/** Control characters would inject exclude lines; a backslash is a separator on Windows. */
function isPlainSegment(segment: string): boolean {
  return (
    segment !== "" &&
    segment !== "." &&
    segment !== ".." &&
    // oxlint-disable-next-line no-control-regex -- control characters are what this rejects
    !/[\u0000-\u001f\u007f\\]/.test(segment)
  );
}

/** A normalized POSIX path under `.opencode/` that a companion copy may occupy. */
export function isPlaceableCopyKey(key: string): boolean {
  if (!key.startsWith(OPENCODE_COPY_PREFIX) || key === OPENCODE_CONFIG_DOCUMENT) return false;
  return key
    .slice(OPENCODE_COPY_PREFIX.length)
    .split("/")
    .every((segment) => isPlainSegment(segment) && !UNCOPIED_SEGMENTS.has(segment));
}

function isPlaceableLinkKey(key: string): boolean {
  const name = LINK_KEY.exec(key)?.[1];
  return name !== undefined && isPlainSegment(name);
}

/** Mate writes exactly one region there: this repository's MCP servers, by key. */
function isOwnLocalConfigRegion(region: unknown, localConfigAt: readonly string[]): boolean {
  return (
    isRecord(region) &&
    region.kind === "map" &&
    isAt(region.at, localConfigAt) &&
    isRecord(region.entries) &&
    !Object.hasOwn(region, "stripPrefix")
  );
}

function regionLabel(documentPath: string, region: unknown): string {
  const at = isRecord(region) && Array.isArray(region.at) ? JSON.stringify(region.at) : "?";
  return `${documentPath} region at ${at}`;
}

function confinedDocuments(
  recorded: Record<string, unknown>,
  repoRoot: string,
  rejected: string[],
): Record<string, ManagedRegion[]> {
  const localConfigAt = ["projects", path.resolve(repoRoot), "mcpServers"];
  const kept: Record<string, ManagedRegion[]> = {};
  for (const [documentPath, regions] of Object.entries(recorded)) {
    if (!PLACED_DOCUMENTS.has(documentPath)) {
      rejected.push(documentPath);
      continue;
    }
    if (documentPath !== CLAUDE_LOCAL_CONFIG_DOCUMENT) {
      kept[documentPath] = regions as ManagedRegion[];
      continue;
    }
    const all: unknown[] = Array.isArray(regions) ? regions : [];
    const own: unknown[] = [];
    for (const region of all) {
      if (isOwnLocalConfigRegion(region, localConfigAt)) own.push(region);
      else rejected.push(regionLabel(documentPath, region));
    }
    if (own.length > 0) kept[documentPath] = own as ManagedRegion[];
    else if (all.length === 0) rejected.push(documentPath);
  }
  return kept;
}

function confinedRecords<T>(
  recorded: Record<string, unknown>,
  placeable: (key: string, record: unknown) => boolean,
  rejected: string[],
): Record<string, T> {
  const kept: Record<string, T> = {};
  for (const [key, record] of Object.entries(recorded)) {
    if (placeable(key, record)) kept[key] = record as T;
    else rejected.push(key);
  }
  return kept;
}

function manifestOf(parsed: Record<string, unknown>, repoRoot: string): ConfinedManifest {
  const rejected: string[] = [];
  const keptDocuments = isRecord(parsed.documents)
    ? confinedDocuments(parsed.documents, repoRoot, rejected)
    : {};
  const keptRuntimes = isRecord(parsed.runtimes)
    ? Object.fromEntries(
        Object.entries(parsed.runtimes as Manifest["runtimes"]).filter(([documentPath]) =>
          Object.hasOwn(keptDocuments, documentPath),
        ),
      )
    : {};
  const keptCopies = isRecord(parsed.copies)
    ? confinedRecords<CopyRecord>(parsed.copies, isPlaceableCopyKey, rejected)
    : {};
  const keptLinks = isRecord(parsed.links)
    ? confinedRecords<LinkRecord>(
        parsed.links,
        (key, record) =>
          isPlaceableLinkKey(key) && isRecord(record) && typeof record.target === "string",
        rejected,
      )
    : {};
  return {
    manifest: {
      documents: keptDocuments,
      runtimes: keptRuntimes,
      copies: keptCopies,
      links: keptLinks,
    },
    rejected,
  };
}

function recordedRuntime(manifest: Manifest, documentPath: string): WrapRuntime {
  return manifest.runtimes[documentPath] ?? documentRuntime(documentPath);
}

/**
 * `null` means the manifest records nothing and its file should not exist.
 * `runtimes` is rebuilt from `documents`, so a legacy manifest is tagged on its
 * next write and a withdrawn document leaves no stale tag behind.
 */
export function serializeManifest(manifest: Manifest): string | null {
  const recorded = Object.keys(manifest.documents);
  const copied = Object.keys(manifest.copies);
  const linked = Object.keys(manifest.links);
  if (recorded.length === 0 && copied.length === 0 && linked.length === 0) return null;
  const runtimes = Object.fromEntries(
    recorded.map((documentPath) => [documentPath, recordedRuntime(manifest, documentPath)]),
  );
  return `${JSON.stringify(
    {
      documents: manifest.documents,
      ...(recorded.length > 0 ? { runtimes } : {}),
      ...(copied.length > 0 ? { copies: manifest.copies } : {}),
      ...(linked.length > 0 ? { links: manifest.links } : {}),
    },
    null,
    2,
  )}\n`;
}

/**
 * Every destination the manifest records, in the order it recorded them,
 * optionally only one runtime's. The manifest is written only by a pass that
 * placed a runtime document or a copy, and `mate wrap` is the only such pass.
 */
export function documents(manifest: Manifest, runtime?: WrapRuntime): string[] {
  return Object.keys(manifest.documents).filter(
    (documentPath) => !runtime || recordedRuntime(manifest, documentPath) === runtime,
  );
}

/** One destination's recorded regions; `undefined` when unrecorded or malformed. */
export function documentRegions(
  manifest: Manifest,
  documentPath: string,
): readonly ManagedRegion[] | undefined {
  const recorded: unknown = manifest.documents[documentPath];
  return Array.isArray(recorded) ? (recorded as ManagedRegion[]) : undefined;
}

/** Owned companion copies, keyed by repo-relative POSIX path. */
export function copies(manifest: Manifest, runtime?: WrapRuntime): Record<string, CopyRecord> {
  return Object.fromEntries(
    Object.entries(manifest.copies).filter(
      ([, record]) => !runtime || (isRecord(record) && record.runtime === runtime),
    ),
  );
}

/** Narrows link records to one link root, e.g. `.claude/skills/`. */
export interface LinkScope {
  prefix?: string;
}

/** Links Mate created, keyed by repo-relative POSIX path. */
export function links(
  manifest: Manifest,
  runtime?: WrapRuntime,
  scope: LinkScope = {},
): Record<string, LinkRecord> {
  return Object.fromEntries(
    Object.entries(manifest.links).filter(
      ([key, record]) =>
        isRecord(record) &&
        typeof record.target === "string" &&
        (!runtime || record.runtime === runtime) &&
        key.startsWith(scope.prefix ?? ""),
    ),
  );
}

function isAt(at: unknown, address: readonly string[]): boolean {
  return (
    Array.isArray(at) &&
    at.length === address.length &&
    at.every((key, index) => key === address[index])
  );
}

/**
 * The keys of the `map` regions recorded at `at` in one document. Shapes are
 * checked rather than trusted: a hand-edited manifest reads as no keys, never
 * as a throw.
 */
export function recordedMapKeys(
  manifest: Manifest,
  documentPath: string,
  at: readonly string[],
): string[] {
  return Object.keys(recordedMapEntries(manifest, documentPath, at));
}

/** The entries of the `map` regions recorded at `at` in one document, checked like {@link recordedMapKeys}. */
export function recordedMapEntries(
  manifest: Manifest,
  documentPath: string,
  at: readonly string[],
): Record<string, unknown> {
  return Object.assign(
    {},
    ...(documentRegions(manifest, documentPath) ?? []).flatMap((region: unknown) =>
      isRecord(region) && region.kind === "map" && isAt(region.at, at) && isRecord(region.entries)
        ? [region.entries]
        : [],
    ),
  ) as Record<string, unknown>;
}

/** Every value of the `list` regions recorded under `prefix` in one document. */
export function recordedListValues(
  manifest: Manifest,
  documentPath: string,
  prefix: readonly string[],
): unknown[] {
  return (documentRegions(manifest, documentPath) ?? []).flatMap((region: unknown) =>
    isRecord(region) &&
    region.kind === "list" &&
    Array.isArray(region.at) &&
    isAt(region.at.slice(0, prefix.length), prefix) &&
    Array.isArray(region.values)
      ? region.values
      : [],
  );
}

/** Records a destination's regions, or withdraws it when `regions` is undefined. */
export function withDocument(
  manifest: Manifest,
  documentPath: string,
  regions: readonly ManagedRegion[] | undefined,
): Manifest {
  if (regions === undefined) return withoutDocuments(manifest, [documentPath]);
  return {
    ...manifest,
    documents: { ...manifest.documents, [documentPath]: [...regions] },
  };
}

export function withoutDocuments(manifest: Manifest, documentPaths: readonly string[]): Manifest {
  const removed = new Set(documentPaths);
  return {
    ...manifest,
    documents: Object.fromEntries(
      Object.entries(manifest.documents).filter(([documentPath]) => !removed.has(documentPath)),
    ),
  };
}

/** Replaces one runtime's records under `prefix`, leaving every other record as it is. */
function replaceRuntimeRecords<T>(
  existing: Readonly<Record<string, T>>,
  runtime: WrapRuntime,
  records: Readonly<Record<string, T>>,
  prefix = "",
): Record<string, T> {
  const kept = Object.entries(existing).filter(
    ([key, record]) => !(isRecord(record) && record.runtime === runtime && key.startsWith(prefix)),
  );
  return { ...Object.fromEntries(kept), ...records };
}

export function withCopies(
  manifest: Manifest,
  runtime: WrapRuntime,
  records: Readonly<Record<string, CopyRecord>>,
): Manifest {
  return { ...manifest, copies: replaceRuntimeRecords(manifest.copies, runtime, records) };
}

export function withLinks(
  manifest: Manifest,
  runtime: WrapRuntime,
  records: Readonly<Record<string, LinkRecord>>,
  scope: LinkScope = {},
): Manifest {
  return {
    ...manifest,
    links: replaceRuntimeRecords(manifest.links, runtime, records, scope.prefix),
  };
}

export function manifestPath(repoPath: string): string {
  return path.join(repoLocalDirPath(repoPath), RUNTIME_DOCUMENT_MANIFEST_FILE);
}

/** Repo-relative, POSIX separators. */
export const MANIFEST_RELATIVE_PATH = `${repoLocalDirName()}/${RUNTIME_DOCUMENT_MANIFEST_FILE}`;

/** Mate never changes tracking within a command, so one answer per repository suffices. */
const trackedManifests = new Map<string, boolean>();

/**
 * Whether Git tracks the manifest, which then reads as absent and is never
 * written: a committed file is the repository's, not Mate's record. Spawns Git
 * only when the file exists; a Git failure answers untracked.
 */
export function manifestTracked(repoPath: string): boolean {
  const root = path.resolve(repoPath);
  const known = trackedManifests.get(root);
  if (known !== undefined) return known;
  if (!fs.existsSync(manifestPath(root))) return false;
  const tracked = gitTracksSync(root, MANIFEST_RELATIVE_PATH);
  trackedManifests.set(root, tracked);
  return tracked;
}

/**
 * The runtime document manifest at the Projection Root; empty when absent. A
 * read that failed for a reason other than absence throws, so a writer never
 * replaces a manifest it could not read.
 */
export async function readManifest(repoPath: string): Promise<Manifest> {
  return parseManifest(await readManifestText(repoPath), repoPath);
}

async function readManifestFile(repoPath: string): Promise<string | null> {
  try {
    return await fsp.readFile(manifestPath(repoPath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

/** `null` when absent or tracked by Git; any other read failure throws. */
export async function readManifestText(repoPath: string): Promise<string | null> {
  const raw = await readManifestFile(repoPath);
  return raw !== null && manifestTracked(repoPath) ? null : raw;
}

/** Lenient: `null` when absent, unreadable or tracked by Git. */
export function readManifestTextSync(repoPath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath(repoPath), "utf8");
  } catch {
    return null;
  }
  return manifestTracked(repoPath) ? null : raw;
}

/** A key may hold a newline; quoting keeps it on one output line. */
function shown(key: string): string {
  // oxlint-disable-next-line no-control-regex -- control characters are what this quotes
  return /[\u0000-\u001f\u007f]/.test(key) ? JSON.stringify(key) : key;
}

/**
 * What a pass tells the operator about the manifest: that Git tracks it, or
 * each record it ignored. Lenient, like the readers it explains.
 */
export async function readManifestNotices(repoPath: string): Promise<string[]> {
  const raw = await readManifestFile(repoPath).catch(() => null);
  if (raw === null) return [];
  if (manifestTracked(repoPath)) {
    return [
      `${MANIFEST_RELATIVE_PATH} is tracked by Git, so its records were ignored and it is left as committed. Untrack it with \`git rm --cached ${MANIFEST_RELATIVE_PATH}\`, then wrap again.`,
    ];
  }
  return confineManifest(raw, repoPath).rejected.map(
    (key) =>
      `${MANIFEST_RELATIVE_PATH} records ${shown(key)}, which is not a destination ${FRAMEWORK_NAME} places; it was ignored and will be dropped on the next write.`,
  );
}

/**
 * The one way the manifest changes: read, edit, then write it atomically — or
 * delete it once it records nothing. Every writer goes through here, so none
 * can drop another's records.
 */
export async function updateManifest(
  repoPath: string,
  edit: (manifest: Manifest) => Manifest,
): Promise<Manifest> {
  const next = edit(await readManifest(repoPath));
  if (manifestTracked(repoPath)) return next;
  const target = manifestPath(repoPath);
  const contents = serializeManifest(next);
  if (contents === null) {
    await fsp.unlink(target).catch(() => {});
  } else {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await writeAtomic(target, contents);
  }
  return next;
}
