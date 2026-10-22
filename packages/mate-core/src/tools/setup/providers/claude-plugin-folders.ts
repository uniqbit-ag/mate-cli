// oxlint-disable no-await-in-loop
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MATE_CLAUDE_PLUGIN_NAME } from "../../../lib/package-paths";
import type { CapabilityContributionInput } from "../plugin";

/** What Claude reads to load a folder as a plugin, relative to that folder. */
export const CLAUDE_PLUGIN_MANIFEST = path.join(".claude-plugin", "plugin.json");

/** Where a folder publishes itself as a marketplace for plain sessions, relative to that folder. */
export const CLAUDE_PLUGIN_MARKETPLACE = path.join(".claude-plugin", "marketplace.json");

/** The owner name that marks a marketplace file as Mate's. */
const MATE_MARKETPLACE_OWNER = "Mate";

const MATE_MARKETPLACE_PREFIX = "mate-plugin-";

/** The marketplace name Mate writes for a plugin. */
function mateMarketplaceName(plugin: string): string {
  return `${MATE_MARKETPLACE_PREFIX}${plugin}`;
}

const RESERVED_MARKETPLACE_NAMES = new Set([
  "claude-plugins-official",
  "inline",
  "builtin",
  "skills-dir",
  "synced",
  "github",
  "npm",
]);

/** Claude Code's marketplace name rules: letters, digits, `.`, `_`, `-`, and no reserved name. */
function isValidMarketplaceName(name: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) &&
    !RESERVED_MARKETPLACE_NAMES.has(name) &&
    !name.startsWith("claudeai-")
  );
}

/** True when `directory` holds a Claude plugin manifest. */
async function hasClaudePluginManifest(directory: string): Promise<boolean> {
  try {
    return (await fs.stat(path.join(directory, CLAUDE_PLUGIN_MANIFEST))).isFile();
  } catch {
    return false;
  }
}

/** Why a launch leaves a declared Claude plugin folder out, in the order they are checked. */
export type ClaudePluginDirectoryProblem =
  | "not-absolute"
  | "bundled-mate-plugin"
  | "missing-manifest"
  | "mate-plugin-name";

/** How a load warning words each problem, after the Capability and the folder. */
const LOAD_WARNINGS: Record<ClaudePluginDirectoryProblem, string> = {
  "not-absolute": "is not an absolute path; it was left out.",
  "bundled-mate-plugin":
    "is Mate's bundled plugin, which every managed launch loads already; it was left out.",
  "missing-manifest": `holds no ${CLAUDE_PLUGIN_MANIFEST}; it was left out.`,
  "mate-plugin-name": `uses Mate's plugin name ${MATE_CLAUDE_PLUGIN_NAME}; it was left out so it cannot replace Mate's guardrail hooks.`,
};

/**
 * The `name` a folder's plugin manifest declares; undefined when the manifest
 * does not parse or holds no string `name`.
 */
async function claudePluginManifestName(directory: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await fs.readFile(path.join(directory, CLAUDE_PLUGIN_MANIFEST), "utf8"),
    ) as { name?: unknown } | null;
    return typeof manifest?.name === "string" ? manifest.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The first problem that leaves `directory` out, if any. `isBundledPlugin` says
 * it resolves to Mate's bundled plugin, which is named as such rather than as a
 * folder using Mate's plugin name.
 */
async function claudePluginDirectoryProblem(
  directory: string,
  isBundledPlugin: boolean,
): Promise<ClaudePluginDirectoryProblem | undefined> {
  if (!path.isAbsolute(directory)) return "not-absolute";
  if (isBundledPlugin) return "bundled-mate-plugin";
  if (!(await hasClaudePluginManifest(directory))) return "missing-manifest";
  return (await claudePluginManifestName(directory)) === MATE_CLAUDE_PLUGIN_NAME
    ? "mate-plugin-name"
    : undefined;
}

/** Declared folders of the Capabilities `enabled` selects, in registration order. */
function* declaredClaudePluginDirectories(
  contributions: CapabilityContributionInput[],
  enabled = true,
): Generator<{ capability: string; directory: string }> {
  for (const input of contributions) {
    if (input.enabled !== enabled) continue;
    for (const { path: directory } of input.contributions.pluginDirectories ?? []) {
      yield { capability: input.pluginId, directory };
    }
  }
}

/** One folder however it is spelled: trailing separators and symlinks resolve to one key. */
async function claudePluginDirectoryKey(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) return directory;
  const resolved = path.resolve(directory);
  return fs.realpath(resolved).catch(() => resolved);
}

// ---------------------------------------------------------------------------
// Publication for plain sessions: each folder is its own `directory`
// marketplace, so Claude Code loads it in place from a wrapped repository's
// settings. Mate reuses an author's marketplace file and owns only its own.
// ---------------------------------------------------------------------------

/** Marketplace names the user's Claude Code configuration declares, each with its recorded sources. */
export type ClaudeUserMarketplaces = ReadonlyMap<string, readonly unknown[]>;

/** Claude Code's own config directory, as Claude Code resolves it. */
function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude");
}

async function readJsonRecord(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The user-scope marketplaces a published name must not shadow. Claude Code
 * rewrites its user record of a name to whichever source the current project
 * declares, so a same-named project marketplace would redirect the user's own.
 *
 * Read from the user's `settings.json`, and from Claude Code's record of known
 * marketplaces for every source other than a `directory`: a recorded directory
 * is what any project's own local marketplace leaves behind, a wrapped
 * repository's included, and is not the user's choice.
 */
export async function readClaudeUserMarketplaces(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeUserMarketplaces> {
  const configDir = claudeConfigDir(env);
  const marketplaces = new Map<string, unknown[]>();
  const add = (name: string, source: unknown) => {
    marketplaces.set(name, [...(marketplaces.get(name) ?? []), source]);
  };
  const settings = await readJsonRecord(path.join(configDir, "settings.json"));
  if (isRecord(settings.extraKnownMarketplaces)) {
    for (const [name, entry] of Object.entries(settings.extraKnownMarketplaces)) {
      add(name, isRecord(entry) ? entry.source : undefined);
    }
  }
  const known = await readJsonRecord(path.join(configDir, "plugins", "known_marketplaces.json"));
  for (const [name, entry] of Object.entries(known)) {
    const source = isRecord(entry) ? entry.source : undefined;
    if (isRecord(source) && source.source === "directory") continue;
    add(name, source);
  }
  return marketplaces;
}

/** A recorded source that is the `directory` marketplace at `directory` itself. */
async function isDirectorySourceAt(source: unknown, directory: string): Promise<boolean> {
  if (!isRecord(source) || source.source !== "directory" || typeof source.path !== "string") {
    return false;
  }
  return (
    path.resolve(source.path) === path.resolve(directory) ||
    (await claudePluginDirectoryKey(source.path)) === (await claudePluginDirectoryKey(directory))
  );
}

/** Why a loadable folder does not reach plain sessions. */
export type ClaudePluginUnpublishedReason =
  | "foreign-marketplace"
  | "invalid-marketplace-name"
  | "name-conflict"
  | "missing-marketplace";

/** The kinds of a folder that claims a marketplace name: published, or published once a pass writes Mate's file. */
type MarketplaceClaimKind = "author-marketplace" | "mate-marketplace" | "pending-marketplace";

/**
 * What a folder is for plain sessions. `author-marketplace` and
 * `mate-marketplace` are published; `pending-marketplace` (no file, or a stale
 * one of Mate's) is published once a pass writes Mate's current file; the rest
 * never are.
 */
type ClaudePluginFolderClass =
  | { kind: "not-loadable"; problem: ClaudePluginDirectoryProblem }
  | { kind: MarketplaceClaimKind; plugin: string; marketplace: string }
  | { kind: "name-conflict"; plugin: string; marketplace: string }
  | { kind: "foreign-marketplace"; plugin: string }
  | { kind: "invalid-marketplace-name"; plugin?: string };

type MarketplaceFile = { state: "absent" } | { state: "present"; text?: string; json: unknown };

async function readMarketplaceFile(directory: string): Promise<MarketplaceFile> {
  let text: string;
  try {
    text = await fs.readFile(path.join(directory, CLAUDE_PLUGIN_MARKETPLACE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "present", json: undefined };
  }
  try {
    return { state: "present", text, json: JSON.parse(text) as unknown };
  } catch {
    return { state: "present", text, json: undefined };
  }
}

/** Mate's file: owned by `Mate` under a `mate-plugin-` name. */
function isMateMarketplace(json: unknown): boolean {
  return (
    isRecord(json) &&
    isRecord(json.owner) &&
    json.owner.name === MATE_MARKETPLACE_OWNER &&
    typeof json.name === "string" &&
    json.name.startsWith(MATE_MARKETPLACE_PREFIX)
  );
}

/** Lists `plugin` as the folder itself, so Claude loads it in place. */
function listsPluginInPlace(json: unknown, plugin: string): boolean {
  return (
    isRecord(json) &&
    Array.isArray(json.plugins) &&
    json.plugins.some(
      (entry) =>
        isRecord(entry) && entry.name === plugin && (entry.source === "./" || entry.source === "."),
    )
  );
}

/** The marketplace file Mate writes for `plugin`, byte-stable across passes. */
function mateMarketplaceText(plugin: string): string {
  return `${JSON.stringify(
    {
      name: mateMarketplaceName(plugin),
      owner: { name: MATE_MARKETPLACE_OWNER },
      plugins: [{ name: plugin, source: "./" }],
    },
    null,
    2,
  )}\n`;
}

/**
 * The marketplace a folder's file claims for `plugin`; undefined for a foreign
 * file. A file of Mate's counts only while it is exactly what Mate writes; any
 * other is pending, like an absent one, so a failed rewrite never leaves the
 * wrap enabling a stale marketplace.
 */
function marketplaceClaim(
  file: MarketplaceFile,
  plugin: string,
): { kind: MarketplaceClaimKind; marketplace: string } | undefined {
  if (file.state === "absent" || isMateMarketplace(file.json)) {
    const current = file.state === "present" && file.text === mateMarketplaceText(plugin);
    return {
      kind: current ? "mate-marketplace" : "pending-marketplace",
      marketplace: mateMarketplaceName(plugin),
    };
  }
  if (
    listsPluginInPlace(file.json, plugin) &&
    isRecord(file.json) &&
    typeof file.json.name === "string"
  ) {
    return { kind: "author-marketplace", marketplace: file.json.name };
  }
  return undefined;
}

/** One folder's class, read-only. */
async function classifyFolder(
  directory: string,
  isBundledPlugin: boolean,
  userMarketplaces: ClaudeUserMarketplaces,
): Promise<ClaudePluginFolderClass> {
  const problem = await claudePluginDirectoryProblem(directory, isBundledPlugin);
  if (problem) return { kind: "not-loadable", problem };
  const plugin = await claudePluginManifestName(directory);
  if (plugin === undefined) return { kind: "invalid-marketplace-name" };

  const claim = marketplaceClaim(await readMarketplaceFile(directory), plugin);
  if (!claim) return { kind: "foreign-marketplace", plugin };
  const { kind, marketplace } = claim;
  if (!isValidMarketplaceName(marketplace)) {
    return kind === "author-marketplace"
      ? { kind: "foreign-marketplace", plugin }
      : { kind: "invalid-marketplace-name", plugin };
  }
  for (const source of userMarketplaces.get(marketplace) ?? []) {
    if (!(await isDirectorySourceAt(source, directory))) {
      return { kind: "name-conflict", plugin, marketplace };
    }
  }
  return { kind, plugin, marketplace };
}

/** One declaration and its folder's class. */
interface ClassifiedFolder {
  capability: string;
  /** The path as the Capability declared it. */
  declared: string;
  /** Absolute: what `--plugin-dir` passes and the wrap's settings name. */
  path: string;
  key: string;
  /** The folder's first declaration; a pass acts on and names it once. */
  first: boolean;
  class: ClaudePluginFolderClass;
}

/** Published, or published once a pass writes Mate's file. */
function claimsMarketplace(
  folderClass: ClaudePluginFolderClass,
): folderClass is Extract<ClaudePluginFolderClass, { kind: MarketplaceClaimKind }> {
  return (
    folderClass.kind === "author-marketplace" ||
    folderClass.kind === "mate-marketplace" ||
    folderClass.kind === "pending-marketplace"
  );
}

/**
 * Every enabled declaration, classified. A marketplace name two folders would
 * both publish under goes to the first; the later one is a `name-conflict`,
 * since one settings key cannot name two sources.
 */
async function classifyFolders(
  contributions: CapabilityContributionInput[],
  bundledPluginRoot: string,
  userMarketplaces: ClaudeUserMarketplaces,
): Promise<ClassifiedFolder[]> {
  const bundledKey = await claudePluginDirectoryKey(bundledPluginRoot);
  const classes = new Map<string, ClaudePluginFolderClass>();
  const claimed = new Map<string, string>();
  const folders: ClassifiedFolder[] = [];
  for (const { capability, directory } of declaredClaudePluginDirectories(contributions)) {
    const key = await claudePluginDirectoryKey(directory);
    const first = !classes.has(key);
    let folderClass =
      classes.get(key) ?? (await classifyFolder(directory, key === bundledKey, userMarketplaces));
    if (claimsMarketplace(folderClass)) {
      const owner = claimed.get(folderClass.marketplace);
      if (owner === undefined) claimed.set(folderClass.marketplace, key);
      else if (owner !== key) folderClass = { ...folderClass, kind: "name-conflict" };
    }
    if (first) classes.set(key, folderClass);
    folders.push({
      capability,
      declared: directory,
      path: path.isAbsolute(directory) ? path.resolve(directory) : directory,
      key,
      first,
      class: folderClass,
    });
  }
  return folders;
}

/** A folder plain sessions load: the Claude wrap enables `plugin@marketplace`. */
export interface PublishedClaudePluginFolder {
  /** Absolute, as the launch passes it. */
  path: string;
  plugin: string;
  marketplace: string;
}

/** One declared Claude plugin folder, as an operator inspects it. */
export interface ClaudePluginDirectoryReport {
  capability: string;
  path: string;
  /**
   * `mate claude` passes the folder: an absolute path holding a plugin manifest,
   * neither Mate's bundled plugin nor using Mate's plugin name.
   */
  loadable: boolean;
  /** Why `mate claude` leaves the folder out; absent when it passes it. */
  problem?: ClaudePluginDirectoryProblem;
  /** The marketplace plain sessions in a wrapped repository load it through; Mate writes its own at the next pass. */
  marketplace?: string;
  /** Why plain sessions do not load a loadable folder. */
  unpublishedReason?: ClaudePluginUnpublishedReason;
}

/** A Capability whose contributions could not be read, so its Claude plugin folders are unknown. */
export interface ClaudePluginContributionFailure {
  capability: string;
  reason: string;
}

/** One loadable folder plain sessions do not load after a publication. */
export interface ClaudePluginUnpublished {
  capability: string;
  path: string;
  reason: ClaudePluginUnpublishedReason;
  /** The reason as a phrase after the folder's path, as `mate wrap`'s note uses it. */
  detail: string;
  /** The whole sentence a launch prints for the folder. */
  warning: string;
}

/** The enabled Capabilities' Claude plugin folders, as one inspection or publication found them. */
export interface ClaudePluginFolders {
  /** Loadable folders, deduplicated, in declaration order: what a managed launch may pass. */
  readonly launch: readonly string[];
  /** One sentence per declared folder left out of every launch. */
  readonly loadWarnings: readonly string[];
  /** Folders the Claude wrap enables. */
  readonly published: readonly PublishedClaudePluginFolder[];
  /** Every declaration, duplicates included, in doctor's report shape. */
  readonly report: readonly ClaudePluginDirectoryReport[];
  /** Present only on a publication's result: what it left undone. */
  readonly publication?: {
    /** Loadable folders plain sessions do not load, one entry each, with its sentence. */
    readonly unpublished: readonly ClaudePluginUnpublished[];
    /** Failures removing Mate's file from disabled Capabilities' folders. */
    readonly warnings: readonly string[];
  };
}

export interface ClaudePluginFoldersOptions {
  /** Mate's bundled plugin, which every managed launch passes before these. */
  bundledPluginRoot: string;
  /** The user's marketplaces; read from the user's Claude Code configuration when absent. */
  userMarketplaces?: ClaudeUserMarketplaces;
}

/**
 * Why a loadable folder is not published, as a phrase after its path; undefined
 * when it is. `writeError` is a publication's failure writing Mate's file.
 */
function unpublishedDetail(
  folderClass: ClaudePluginFolderClass,
  writeError: string | undefined,
): { reason: ClaudePluginUnpublishedReason; detail: string } | undefined {
  switch (folderClass.kind) {
    case "foreign-marketplace":
      return {
        reason: "foreign-marketplace",
        detail: `holds a ${CLAUDE_PLUGIN_MARKETPLACE} that Mate did not write and that does not list the plugin in place`,
      };
    case "invalid-marketplace-name":
      return {
        reason: "invalid-marketplace-name",
        detail: "has a plugin name that cannot form a Claude Code marketplace name",
      };
    case "name-conflict":
      return {
        reason: "name-conflict",
        detail: `would publish as marketplace ${folderClass.marketplace}, a name already in use with another source`,
      };
    case "pending-marketplace":
      return {
        reason: "missing-marketplace",
        detail: `holds no current ${CLAUDE_PLUGIN_MARKETPLACE}, and Mate could not write one${writeError ? ` (${writeError})` : ""}`,
      };
    default:
      return undefined;
  }
}

function reportOf({
  capability,
  declared,
  class: folderClass,
}: ClassifiedFolder): ClaudePluginDirectoryReport {
  if (folderClass.kind === "not-loadable") {
    return { capability, path: declared, loadable: false, problem: folderClass.problem };
  }
  const report: ClaudePluginDirectoryReport = { capability, path: declared, loadable: true };
  if (claimsMarketplace(folderClass)) report.marketplace = folderClass.marketplace;
  else report.unpublishedReason = folderClass.kind;
  return report;
}

function foldersValue(
  folders: ClassifiedFolder[],
  publication?: { writeErrors: ReadonlyMap<string, string>; warnings: string[] },
): ClaudePluginFolders {
  const firsts = folders.filter((folder) => folder.first);
  const value: ClaudePluginFolders = {
    launch: firsts.flatMap((folder) => (folder.class.kind === "not-loadable" ? [] : [folder.path])),
    loadWarnings: firsts.flatMap(({ capability, declared, class: folderClass }) =>
      folderClass.kind === "not-loadable"
        ? [`${capability}: Claude plugin folder ${declared} ${LOAD_WARNINGS[folderClass.problem]}`]
        : [],
    ),
    published: firsts.flatMap(({ path: folder, class: folderClass }) =>
      folderClass.kind === "author-marketplace" || folderClass.kind === "mate-marketplace"
        ? [{ path: folder, plugin: folderClass.plugin, marketplace: folderClass.marketplace }]
        : [],
    ),
    report: folders.map(reportOf),
  };
  if (!publication) return value;
  return {
    ...value,
    publication: {
      unpublished: firsts.flatMap((folder) =>
        unpublishedEntries(folder, publication.writeErrors.get(folder.key)),
      ),
      warnings: publication.warnings,
    },
  };
}

/** The folder's entry when a publication left it unpublished; none when it is published. */
function unpublishedEntries(
  { capability, path: folder, class: folderClass }: ClassifiedFolder,
  writeError: string | undefined,
): ClaudePluginUnpublished[] {
  const unpublished = unpublishedDetail(folderClass, writeError);
  if (!unpublished) return [];
  return [
    {
      capability,
      path: folder,
      ...unpublished,
      warning: `${capability}: Claude plugin folder ${folder} ${unpublished.detail}; plain \`claude\` sessions do not load it.`,
    },
  ];
}

/**
 * The enabled Capabilities' Claude plugin folders, read-only. A folder Mate has
 * not written a current marketplace file for yet is not published, and its
 * report names the marketplace Mate will write.
 */
export async function inspectClaudePluginFolders(
  contributions: CapabilityContributionInput[],
  options: ClaudePluginFoldersOptions,
): Promise<ClaudePluginFolders> {
  const userMarketplaces = options.userMarketplaces ?? (await readClaudeUserMarketplaces());
  return foldersValue(
    await classifyFolders(contributions, options.bundledPluginRoot, userMarketplaces),
  );
}

/**
 * Writes Mate's marketplace file into every enabled folder that has none or a
 * stale one of Mate's, removes Mate's file from folders only disabled
 * Capabilities declare, then inspects. Never touches a file Mate did not write.
 * A file it could not write leaves the folder unpublished, with the error.
 */
export async function publishClaudePluginFolders(
  contributions: CapabilityContributionInput[],
  options: ClaudePluginFoldersOptions,
): Promise<ClaudePluginFolders> {
  const userMarketplaces = options.userMarketplaces ?? (await readClaudeUserMarketplaces());
  const before = await classifyFolders(contributions, options.bundledPluginRoot, userMarketplaces);
  const writeErrors = await writePendingMarketplaces(before);
  const enabledKeys = new Set(before.map((folder) => folder.key));
  const warnings = await removeDisabledMarketplaces(contributions, enabledKeys);
  return foldersValue(
    await classifyFolders(contributions, options.bundledPluginRoot, userMarketplaces),
    { writeErrors, warnings },
  );
}

/** Writes Mate's file into each pending folder; returns each failure's message by folder key. */
async function writePendingMarketplaces(folders: ClassifiedFolder[]): Promise<Map<string, string>> {
  const writeErrors = new Map<string, string>();
  for (const folder of folders) {
    if (!folder.first || folder.class.kind !== "pending-marketplace") continue;
    try {
      await fs.writeFile(
        path.join(folder.path, CLAUDE_PLUGIN_MARKETPLACE),
        mateMarketplaceText(folder.class.plugin),
        "utf8",
      );
    } catch (error) {
      writeErrors.set(folder.key, (error as Error).message);
    }
  }
  return writeErrors;
}

/**
 * Removes Mate's file from folders only disabled Capabilities declare; returns
 * one warning per file it could not remove.
 */
async function removeDisabledMarketplaces(
  contributions: CapabilityContributionInput[],
  enabledKeys: ReadonlySet<string>,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const { capability, directory } of declaredClaudePluginDirectories(contributions, false)) {
    if (!path.isAbsolute(directory)) continue;
    if (enabledKeys.has(await claudePluginDirectoryKey(directory))) continue;
    const file = await readMarketplaceFile(directory);
    if (file.state !== "present" || !isMateMarketplace(file.json)) continue;
    const marketplacePath = path.join(directory, CLAUDE_PLUGIN_MARKETPLACE);
    try {
      await fs.rm(marketplacePath, { force: true });
    } catch (error) {
      warnings.push(
        `${capability}: could not remove ${marketplacePath}: ${(error as Error).message}.`,
      );
    }
  }
  return warnings;
}
