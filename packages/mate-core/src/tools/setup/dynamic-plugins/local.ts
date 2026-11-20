import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMap, isSeq, parse, parseDocument } from "yaml";

import type { PluginDeclaration } from "../../../lib/orchestrator/types";
import { gitTrackedUnder } from "../../../runtime/git-tracked";
import { writeAtomicThroughLink } from "../../../runtime/write-atomic";
import type {
  CapabilityPlugin,
  Plugin,
  RuntimeContributions,
  RuntimeContributionsByRuntime,
} from "../plugin";
import { addManagedGitignoreEntries } from "../plugins/gitignore";
import type { PluginRegistry } from "../registry";
import {
  committedPluginPackages,
  effectivePluginEntries,
  type OriginPluginEntry,
} from "./audiences";
import { validateDeclaration } from "./declarations";
import {
  installDeclaredPlugins,
  type PluginInstallDeps,
  type PluginInstallResult,
} from "./install";
import {
  dynamicPluginsWorkspaceRoot,
  LOCAL_PLUGIN_ORIGIN,
  LOCAL_PLUGINS_FILE_GITIGNORE_ENTRY as LOCAL_FILE,
  LOCAL_PLUGINS_WORKSPACE_GITIGNORE_ENTRY as LOCAL_WORKSPACE,
  localPluginsFilePath,
  PLUGIN_LOCAL_OVERRIDES_GITIGNORE_ENTRY,
} from "./paths";

export interface LocalPluginProblem {
  /** The package at fault; absent when the whole file is. */
  package?: string;
  message: string;
}

export interface LocalPluginRead {
  present: boolean;
  /** Usable entries. A problem with the file as a whole leaves none. */
  declarations: PluginDeclaration[];
  problems: LocalPluginProblem[];
}

const NO_LOCAL_PLUGINS: LocalPluginRead = { present: false, declarations: [], problems: [] };
const MAX_LISTED_TRACKED_PATHS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Without a readable `framework.yaml`, conflicts with committed plugins cannot be ruled out. */
function supportsLocalPlugins(framework: unknown): boolean {
  return isRecord(framework) && framework.type !== "hub";
}

function fileProblem(message: string): LocalPluginRead {
  return { present: true, declarations: [], problems: [{ message }] };
}

async function trackedStateProblem(companionPath: string): Promise<string | null> {
  const tracked = await gitTrackedUnder(companionPath, [
    LOCAL_FILE,
    LOCAL_WORKSPACE.replace(/\/$/, ""),
  ]);
  if (tracked.length === 0) return null;
  const listed = tracked.slice(0, MAX_LISTED_TRACKED_PATHS).join(", ");
  const more = tracked.length - MAX_LISTED_TRACKED_PATHS;
  return `Git tracks local plugin state, so no local plugin is used: ${listed}${more > 0 ? ` and ${more} more` : ""}. Untrack it with \`git rm --cached\`.`;
}

/** What blocks writing local state. Without a local file, reading never reached the tracked check. */
async function writeProblems(
  companionPath: string,
  read: LocalPluginRead,
): Promise<LocalPluginProblem[]> {
  if (read.present) return read.problems;
  const message = await trackedStateProblem(companionPath);
  return message ? [{ message }] : [];
}

function describeLocalConflict(packageName: string): string {
  return `plugin "${packageName}" is declared in framework.yaml, so ${LOCAL_FILE} cannot declare it too; remove one declaration.`;
}

/**
 * Reads `framework.local.yaml` apart from `ConfigStore`, so no config save can
 * carry its entries into `framework.yaml`. `framework` is the raw or loaded
 * `framework.yaml`. A conflict drops only its entry; any other problem drops
 * them all. Hubs have no local plugins.
 */
export async function readLocalPlugins(
  companionPath: string,
  framework: unknown,
): Promise<LocalPluginRead> {
  if (!supportsLocalPlugins(framework)) return NO_LOCAL_PLUGINS;

  let text: string;
  try {
    text = await fs.readFile(localPluginsFilePath(companionPath), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return NO_LOCAL_PLUGINS;
    return fileProblem(`${LOCAL_FILE} could not be read: ${(error as Error).message}`);
  }

  // Before parsing: a tracked file came from someone else and is not trusted at all.
  const tracked = await trackedStateProblem(companionPath);
  if (tracked) return fileProblem(tracked);

  let raw: unknown;
  try {
    raw = parse(text) as unknown;
  } catch (error) {
    return fileProblem(`${LOCAL_FILE} is not valid YAML: ${(error as Error).message}`);
  }
  raw ??= {};
  if (!isRecord(raw)) return fileProblem(`${LOCAL_FILE} must be a mapping with a plugins list.`);
  const unknownKeys = Object.keys(raw).filter((key) => key !== "plugins");
  if (unknownKeys.length > 0) {
    return fileProblem(`${LOCAL_FILE} may contain only plugins; found: ${unknownKeys.join(", ")}.`);
  }
  const entries = raw.plugins ?? [];
  if (!Array.isArray(entries)) return fileProblem(`${LOCAL_FILE}: plugins must be a list.`);

  const declarations: PluginDeclaration[] = [];
  const problems: LocalPluginProblem[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const { declaration, error } = validateDeclaration(entry);
    if (!declaration) {
      problems.push({ message: `${LOCAL_FILE}: ${error ?? "invalid plugins entry"}` });
    } else if (seen.has(declaration.package)) {
      problems.push({
        message: `${LOCAL_FILE}: package "${declaration.package}" is declared more than once.`,
      });
    } else {
      seen.add(declaration.package);
      declarations.push(declaration);
    }
  }
  if (problems.length > 0) return { present: true, declarations: [], problems };

  const committed = committedPluginPackages(framework);
  return {
    present: true,
    declarations: declarations.filter((declaration) => !committed.has(declaration.package)),
    problems: declarations
      .filter((declaration) => committed.has(declaration.package))
      .map((declaration) => ({
        package: declaration.package,
        message: describeLocalConflict(declaration.package),
      })),
  };
}

export async function isDeclaredLocally(
  companionPath: string,
  framework: unknown,
  packageName: string,
): Promise<boolean> {
  const { declarations, problems } = await readLocalPlugins(companionPath, framework);
  return [...declarations, ...problems].some((item) => item.package === packageName);
}

/** The committed entries of the active audience, then this machine's local ones. */
export async function readLoadableEntries(
  companionPath: string,
  framework: unknown,
  audience: string | null,
): Promise<{ entries: OriginPluginEntry[]; problems: LocalPluginProblem[] }> {
  const { declarations, problems } = await readLocalPlugins(companionPath, framework);
  return {
    entries: [
      ...effectivePluginEntries(framework, audience),
      ...declarations.map((entry) => ({ entry, origin: LOCAL_PLUGIN_ORIGIN })),
    ],
    problems,
  };
}

/** `mate install` and `mate plugin install` do not run the gitignore plugin. */
async function ensureLocalPluginIgnores(companionPath: string): Promise<void> {
  await addManagedGitignoreEntries(path.join(companionPath, ".gitignore"), [
    LOCAL_FILE,
    LOCAL_WORKSPACE,
    PLUGIN_LOCAL_OVERRIDES_GITIGNORE_ENTRY,
  ]);
}

function tarballPath(version: string, workspaceRoot: string): string | null {
  if (!version.startsWith("file:")) return null;
  if (version.startsWith("file://")) {
    try {
      return fileURLToPath(version);
    } catch {
      return null;
    }
  }
  const target = version.slice("file:".length);
  return target.startsWith("~/")
    ? path.join(os.homedir(), target.slice(2))
    : path.resolve(workspaceRoot, target);
}

async function tarballIntegrity(file: string): Promise<string | null> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return null;
  return `sha512-${createHash("sha512")
    .update(await fs.readFile(file))
    .digest("base64")}`;
}

/**
 * npm keeps a rebuilt tarball's old content, or fails on its old checksum,
 * while the lockfile records it. A difference therefore clears both the tree
 * and the lockfile, which makes the install step resolve the tarball again.
 */
async function dropStaleTarballInstall(
  workspaceRoot: string,
  declarations: PluginDeclaration[],
): Promise<void> {
  const lockPath = path.join(workspaceRoot, "package-lock.json");
  let locked: Record<string, { integrity?: unknown } | undefined>;
  try {
    locked =
      (JSON.parse(await fs.readFile(lockPath, "utf8")) as { packages?: typeof locked }).packages ??
      {};
  } catch {
    return;
  }
  const checks = await Promise.all(
    declarations.map(async ({ package: name, version }) => {
      const recorded = locked[`node_modules/${name}`]?.integrity;
      const file = tarballPath(version, workspaceRoot);
      if (typeof recorded !== "string" || !file) return false;
      const current = await tarballIntegrity(file);
      return current !== null && current !== recorded;
    }),
  );
  if (!checks.includes(true)) return;
  await fs.rm(path.join(workspaceRoot, "node_modules"), { recursive: true, force: true });
  await fs.rm(lockPath, { force: true });
}

function refusals(problems: LocalPluginProblem[]): PluginInstallResult[] {
  return problems.map((problem) => ({
    package: problem.package ?? LOCAL_FILE,
    status: "failed",
    error: problem.message,
    refused: true,
  }));
}

/**
 * The local step of an ordinary install. Any refusal stops it before npm runs.
 * A deleted local file still prunes the workspace it leaves behind.
 */
export async function installLocalPlugins(
  companionPath: string,
  framework: unknown,
  deps?: PluginInstallDeps,
): Promise<{ results: PluginInstallResult[]; declared: boolean }> {
  if (!supportsLocalPlugins(framework)) return { results: [], declared: false };
  const workspaceRoot = dynamicPluginsWorkspaceRoot(companionPath, LOCAL_PLUGIN_ORIGIN);
  const read = await readLocalPlugins(companionPath, framework);
  const problems = await writeProblems(companionPath, read);
  if (problems.length > 0) return { results: refusals(problems), declared: false };
  if (!read.present) {
    const hasWorkspace = await fs.stat(path.join(workspaceRoot, "package.json")).catch(() => null);
    if (!hasWorkspace) return { results: [], declared: false };
  }

  if (read.present) await ensureLocalPluginIgnores(companionPath);
  await dropStaleTarballInstall(workspaceRoot, read.declarations);
  return {
    results: await installDeclaredPlugins(workspaceRoot, read.declarations, deps),
    declared: read.declarations.length > 0,
  };
}

/**
 * Adds or updates one entry, keeping the file's comments. Returns what refuses
 * the declaration; a refusal writes nothing. The ignore entries land first, so
 * the new file never shows up in `git status`.
 */
export async function declareLocalPlugin(
  companionPath: string,
  framework: unknown,
  packageName: string,
  version: string,
): Promise<LocalPluginProblem[]> {
  if (!supportsLocalPlugins(framework)) {
    return [{ message: "local plugins need a companion; hubs do not support them." }];
  }
  const problems = await writeProblems(
    companionPath,
    await readLocalPlugins(companionPath, framework),
  );
  if (problems.length > 0) return problems;
  if (committedPluginPackages(framework).has(packageName)) {
    return [{ package: packageName, message: describeLocalConflict(packageName) }];
  }
  await ensureLocalPluginIgnores(companionPath);

  const file = localPluginsFilePath(companionPath);
  const document = parseDocument(await fs.readFile(file, "utf8").catch(() => ""));
  const plugins = document.get("plugins");
  const entry = { package: packageName, version };
  if (isSeq(plugins)) {
    const existing = plugins.items.find(
      (item) => isMap(item) && item.get("package") === packageName,
    );
    if (!isMap(existing)) plugins.add(document.createNode(entry));
    else if (existing.get("version") === version) return [];
    else existing.set("version", version);
  } else {
    document.set("plugins", document.createNode([entry]));
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Atomic: every command reads this file at startup.
  await writeAtomicThroughLink(file, document.toString());
  return [];
}

const KEPT_CONTRIBUTIONS = new Set(["hookGroups", "permissionEntries", "pluginDirectories"]);

const SKIPPED_CONTRIBUTION_LABELS: Record<string, string> = {
  skillTrees: "skills",
  agentDefinitions: "agent definitions",
  guidanceSections: "guidance sections",
  mcpServers: "MCP servers",
  pluginReferences: "plugin references",
};

function isContributed(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== undefined;
}

/**
 * Limits a local plugin to outputs that stay on this machine. The contribution
 * list names what is kept, so a future kind is dropped until allowed. Local
 * plugins also stay out of the setup selector, whose answer `framework.yaml` saves.
 */
function confineLocalPlugin(
  plugin: Plugin,
  packageName: string,
  warn: (message: string) => void,
): Plugin {
  const reported = new Set<string>();
  const report = (kinds: Iterable<string>) => {
    const fresh = [...kinds].filter((kind) => !reported.has(kind));
    if (fresh.length === 0) return;
    for (const kind of fresh) reported.add(kind);
    warn(
      `local plugin "${packageName}": skipped ${fresh.join(", ")}; local plugins keep only Claude hooks, permissions and plugin folders, and CLI commands.`,
    );
  };

  const capability = plugin as CapabilityPlugin;
  const contributions = capability.getRuntimeContributions?.bind(capability);
  if (contributions) {
    capability.getRuntimeContributions = async (ctx) => {
      const confined: RuntimeContributionsByRuntime = {};
      const skipped = new Set<string>();
      for (const [runtime, declared] of Object.entries(await contributions(ctx))) {
        if (!declared) continue;
        const entries = Object.entries(declared);
        confined[runtime] = Object.fromEntries(
          entries.filter(([key]) => KEPT_CONTRIBUTIONS.has(key)),
        ) as RuntimeContributions;
        for (const [key, value] of entries) {
          if (!KEPT_CONTRIBUTIONS.has(key) && isContributed(value)) {
            skipped.add(SKIPPED_CONTRIBUTION_LABELS[key] ?? key);
          }
        }
      }
      report(skipped);
      return confined;
    };
  }

  const gitignoreEntries = plugin.gitignoreEntries?.bind(plugin);
  plugin.gitignoreEntries = (ctx) => {
    if (gitignoreEntries?.(ctx).length) report(["gitignore entries"]);
    return [];
  };
  plugin.selectable = false;
  return plugin;
}

/**
 * The confined plugin to register, or null when a registered plugin already
 * holds its id or cap namespace: committed plugins always keep theirs.
 */
export function admitLocalPlugin(
  registry: PluginRegistry,
  plugin: Plugin,
  packageName: string,
  warn: (message: string) => void,
): Plugin | null {
  const namespace = plugin.cliNamespace ?? plugin.id;
  const holder = registry
    .getAll()
    .find(
      (existing) =>
        existing.id === plugin.id || (existing.cliNamespace ?? existing.id) === namespace,
    );
  if (holder) {
    warn(
      `local plugin "${packageName}" ("${plugin.id}") skipped: "${holder.id}" already holds its id or cap namespace "${namespace}".`,
    );
    return null;
  }
  return confineLocalPlugin(plugin, packageName, warn);
}
