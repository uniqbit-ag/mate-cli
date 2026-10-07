import { createHash, randomUUID } from "node:crypto";
import fs, { type Dirent, type FSWatcher, type Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { gitEnvironment } from "../../../runtime/companion-git";

export interface VaultTreeNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  children?: VaultTreeNode[];
}

export interface VaultFile {
  path: string;
  content: string;
  token: string;
}

export interface VaultConflict {
  kind: "conflict";
  path: string;
  reason: string;
  content: string;
  token: string;
}

export interface VaultSaved {
  kind: "saved";
  path: string;
  token: string;
}

export interface VaultWatchEvent {
  kind: "changed" | "removed" | "overwritten";
  path: string;
  content?: string;
  token?: string;
  recoveredContent?: string;
  recoveredToken?: string;
}

export interface VaultTreeResult {
  tree: VaultTreeNode[];
  watching: boolean;
  warning: string | null;
}

export interface VaultPath {
  root: string;
  absolute: string;
  relative: string;
}

export class VaultPathError extends Error {
  readonly code = "VAULT_PATH_REFUSED";

  constructor(message: string) {
    super(message);
    this.name = "VaultPathError";
  }
}

export interface VaultWatcher {
  close(): void;
}

export interface VaultGitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Rejects only when Git cannot be started; a non-zero exit resolves with its code. */
export type VaultGitRunner = (args: string[], input?: string) => Promise<VaultGitResult>;

export interface VaultListingFs {
  realpath(target: string): Promise<string>;
  stat(target: string): Promise<Stats>;
  readdir(target: string): Promise<Dirent[]>;
}

export interface VaultListingDeps {
  git?: VaultGitRunner;
  fs?: Partial<VaultListingFs>;
}

export interface VaultDeps extends VaultListingDeps {
  /** Called once per directory; the watch is not recursive. */
  watch?: (
    directory: string,
    listener: (event: string, filename: string | Buffer | null) => void,
  ) => VaultWatcher;
  beforeWrite?: (absolutePath: string) => Promise<void> | void;
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

function isMarkdown(requestedPath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(requestedPath).toLowerCase());
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function realpathContaining(root: string, candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      return await fsp.realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/** Resolves links before containment is checked, including paths that do not exist yet. */
export async function resolveVaultPath(
  companionRoot: string,
  requestedPath: string,
): Promise<VaultPath> {
  if (!requestedPath || requestedPath.includes("\0") || path.isAbsolute(requestedPath)) {
    throw new VaultPathError("vault paths must be relative markdown paths inside the companion");
  }
  if (!isMarkdown(requestedPath)) {
    throw new VaultPathError("the vault only exposes markdown files");
  }

  const root = await fsp.realpath(companionRoot).catch(() => {
    throw new VaultPathError("the selected Companion Repository is unavailable");
  });
  const lexical = path.resolve(root, requestedPath);
  if (!inside(root, lexical))
    throw new VaultPathError("the requested path leaves the companion root");

  let absolute: string;
  try {
    absolute = await fsp.realpath(lexical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const containing = await realpathContaining(root, path.dirname(lexical));
    if (!inside(root, containing))
      throw new VaultPathError("the requested path leaves the companion root");
    absolute = lexical;
  }
  if (!inside(root, absolute))
    throw new VaultPathError("the requested path leaves the companion root");

  try {
    if (!(await fsp.stat(absolute)).isFile())
      throw new VaultPathError("the requested path is not a file");
  } catch (error) {
    if (error instanceof VaultPathError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return { root, absolute, relative: path.relative(root, absolute) || requestedPath };
}

function runGit(args: string[], input?: string): Promise<VaultGitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["pipe", "pipe", "pipe"], env: gitEnvironment() });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
    child.stdin.end(input ?? "");
  });
}

const defaultListingFs: VaultListingFs = {
  realpath: (target) => fsp.realpath(target),
  stat: (target) => fsp.stat(target),
  readdir: (target) => fsp.readdir(target, { withFileTypes: true }),
};

async function ignored(git: VaultGitRunner, root: string, relative: string): Promise<boolean> {
  try {
    const result = await git(["-C", root, "check-ignore", "--no-index", "--quiet", "--", relative]);
    return result.code === 0;
  } catch {
    return false;
  }
}

async function containedFile(
  vaultFs: VaultListingFs,
  root: string,
  relative: string,
): Promise<boolean> {
  try {
    const resolved = await vaultFs.realpath(path.join(root, relative));
    return inside(root, resolved) && (await vaultFs.stat(resolved)).isFile();
  } catch {
    return false;
  }
}

/** Only used outside a Git checkout, where nothing counts as ignored. */
async function walkFiles(
  vaultFs: VaultListingFs,
  root: string,
  current: string,
  relativeDir: string,
  output: string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await vaultFs.readdir(current);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const relative = path.join(relativeDir, entry.name);
    let resolved: string;
    let stats: Stats;
    try {
      resolved = await vaultFs.realpath(path.join(current, entry.name));
      if (!inside(root, resolved)) continue;
      stats = await vaultFs.stat(resolved);
    } catch {
      continue;
    }
    if (stats.isDirectory()) await walkFiles(vaultFs, root, resolved, relative, output);
    else if (stats.isFile() && isMarkdown(relative)) output.push(relative);
  }
}

function notACheckout(error: unknown, result?: VaultGitResult): boolean {
  if (error) return (error as NodeJS.ErrnoException).code === "ENOENT";
  return result !== undefined && /not a git repository/i.test(result.stderr);
}

/**
 * Two Git processes per listing, whatever the repository size. `--no-index`
 * keeps tracked files that match an ignore pattern hidden.
 */
async function listMarkdownFiles(root: string, deps: VaultListingDeps): Promise<string[]> {
  const git = deps.git ?? runGit;
  const vaultFs = { ...defaultListingFs, ...deps.fs };
  let listed: VaultGitResult;
  try {
    listed = await git([
      "-C",
      root,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ]);
  } catch (error) {
    if (!notACheckout(error)) throw error;
    const files: string[] = [];
    await walkFiles(vaultFs, root, root, "", files);
    return files;
  }
  if (listed.code !== 0) {
    if (notACheckout(null, listed)) {
      const files: string[] = [];
      await walkFiles(vaultFs, root, root, "", files);
      return files;
    }
    throw new Error(`git ls-files failed: ${listed.stderr.trim() || `exit ${listed.code}`}`);
  }

  const candidates = [...new Set(listed.stdout.split("\0").filter(Boolean))].filter(isMarkdown);
  if (candidates.length === 0) return [];
  const checked = await git(
    ["-C", root, "check-ignore", "--no-index", "-z", "--stdin"],
    `${candidates.join("\0")}\0`,
  );
  if (checked.code !== 0 && checked.code !== 1)
    throw new Error(`git check-ignore failed: ${checked.stderr.trim() || `exit ${checked.code}`}`);
  const ignoredPaths = new Set(checked.stdout.split("\0").filter(Boolean));

  const relatives = candidates.flatMap((candidate) =>
    ignoredPaths.has(candidate) ? [] : [path.join(...candidate.split("/"))],
  );
  const kept = await Promise.all(
    relatives.map((relative) => containedFile(vaultFs, root, relative)),
  );
  return relatives.filter((_relative, index) => kept[index]);
}

function asTree(paths: string[]): VaultTreeNode[] {
  const roots: VaultTreeNode[] = [];
  for (const filePath of paths.sort((a, b) => a.localeCompare(b))) {
    let level = roots;
    const parts = filePath.split(path.sep);
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index]!;
      const currentPath = parts.slice(0, index + 1).join(path.sep);
      let node = level.find((candidate) => candidate.name === name);
      if (!node) {
        node = {
          name,
          path: currentPath,
          kind: index === parts.length - 1 ? "file" : "directory",
          ...(index === parts.length - 1 ? {} : { children: [] }),
        };
        level.push(node);
      }
      if (node.children) level = node.children;
    }
  }
  return roots;
}

/** Collects every non-ignored markdown file under a companion root. */
export async function collectMarkdownTree(
  companionRoot: string,
  deps: VaultListingDeps = {},
): Promise<VaultTreeNode[]> {
  const root = await fsp.realpath(companionRoot);
  return asTree(await listMarkdownFiles(root, deps));
}

/** The token is opaque to callers and changes whenever the bytes change. */
export function versionToken(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readVaultFile(companionRoot: string, requestedPath: string): Promise<VaultFile> {
  const resolved = await resolveVaultPath(companionRoot, requestedPath);
  const content = await fsp.readFile(resolved.absolute, "utf8");
  return { path: resolved.relative, content, token: versionToken(content) };
}

function defaultWatcher(
  directory: string,
  listener: (event: string, filename: string | Buffer | null) => void,
): VaultWatcher {
  const watcher: FSWatcher = fs.watch(directory, listener);
  /** A removed directory errors its watcher; the next listing drops it. */
  watcher.on("error", () => watcher.close());
  return { close: () => watcher.close() };
}

/** The root, every directory holding a listed file, and their ancestors. */
function watchedDirectories(root: string, files: string[]): Set<string> {
  const directories = new Set([root]);
  for (const file of files) {
    let current = path.dirname(path.join(root, file));
    while (current !== root && !directories.has(current)) {
      directories.add(current);
      current = path.dirname(current);
    }
  }
  return directories;
}

interface SaveRecord {
  path: string;
  content: string;
  token: string;
  currentToken: string;
  windowOpen: boolean;
  expires: ReturnType<typeof setTimeout>;
}

interface Subscriber {
  path: string;
  notify: (event: VaultWatchEvent) => void;
}

export interface VaultManager {
  tree(companionRoot: string, refresh?: boolean): Promise<VaultTreeResult>;
  /** The cached tree, or `null` after starting (or joining) a listing in the background. */
  prefetch(companionRoot: string, refresh?: boolean): Promise<VaultTreeResult | null>;
  open(companionRoot: string, requestedPath: string): Promise<VaultFile>;
  save(
    companionRoot: string,
    requestedPath: string,
    content: string,
    token?: string,
  ): Promise<VaultSaved | VaultConflict>;
  subscribe(
    companionRoot: string,
    requestedPath: string,
    notify: (event: VaultWatchEvent) => void,
  ): () => void;
  refresh(companionRoot: string): Promise<VaultTreeResult>;
  deactivate(): void;
  stop(): void;
  getRecovery(companionRoot: string, requestedPath: string): VaultWatchEvent | null;
}

/** Owns one tree cache and one set of per-directory watchers per selected companion process. */
export function createVaultManager(deps: VaultDeps = {}): VaultManager {
  const watch = deps.watch ?? defaultWatcher;
  const git = deps.git ?? runGit;
  const trees = new Map<string, VaultTreeNode[]>();
  const generations = new Map<string, number>();
  const listings = new Map<string, Promise<VaultTreeNode[]>>();
  const listed = new Map<string, string[]>();
  const warnings = new Map<string, string | null>();
  const watchers = new Map<string, Map<string, VaultWatcher>>();
  const reconciles = new Map<string, Set<string>>();
  /** Directories created since the last listing; they hold no listed file yet. */
  const adopted = new Map<string, Set<string>>();
  let activeRoot: string | null = null;
  const subscribers = new Map<string, Set<Subscriber>>();
  const pendingEvents = new Map<string, ReturnType<typeof setTimeout>>();
  const locks = new Map<string, Promise<unknown>>();
  const recentSaves = new Map<string, SaveRecord>();
  const recoveries = new Map<string, VaultWatchEvent>();

  const rootKey = async (root: string) => fsp.realpath(root);

  const invalidate = (root: string) => {
    trees.delete(root);
    generations.set(root, (generations.get(root) ?? 0) + 1);
  };

  const notify = async (
    root: string,
    relative: string,
    observed: Promise<VaultFile | null> = readVaultFile(root, relative).catch(() => null),
    saveWasActive = false,
  ) => {
    const key = `${root}\0${relative}`;
    const prior = pendingEvents.get(key);
    if (prior) clearTimeout(prior);
    pendingEvents.set(
      key,
      setTimeout(() => {
        pendingEvents.delete(key);
        void (async () => {
          let event: VaultWatchEvent;
          try {
            const current = await observed;
            if (!current) throw new Error("file removed");
            event = {
              kind: "changed",
              path: current.path,
              content: current.content,
              token: current.token,
            };
            const save = recentSaves.get(`${root}\0${current.path}`);
            if (
              save &&
              saveWasActive &&
              save.token !== current.token &&
              save.currentToken !== current.token
            ) {
              event = {
                kind: "overwritten",
                path: current.path,
                content: current.content,
                token: current.token,
                recoveredContent: current.content,
                recoveredToken: current.token,
              };
              recoveries.set(`${root}\0${current.path}`, event);
            }
          } catch {
            event = { kind: "removed", path: relative };
          }
          const listeners = subscribers.get(key);
          for (const subscriber of listeners ?? []) subscriber.notify(event);
        })();
      }, 25),
    );
  };

  const observeNow = (root: string, relative: string): Promise<VaultFile | null> => {
    try {
      const candidate = path.resolve(root, relative);
      const resolved = fs.realpathSync(candidate);
      if (!inside(root, resolved) || !isMarkdown(relative)) return Promise.resolve(null);
      const content = fs.readFileSync(resolved, "utf8");
      return Promise.resolve({
        path: path.relative(root, resolved),
        content,
        token: versionToken(content),
      });
    } catch {
      return Promise.resolve(null);
    }
  };

  const closeWatchers = (root: string) => {
    for (const watcher of watchers.get(root)?.values() ?? []) watcher.close();
    watchers.delete(root);
    reconciles.delete(root);
    adopted.delete(root);
  };

  const unavailable = (root: string, error: unknown) => {
    closeWatchers(root);
    warnings.set(
      root,
      `Live updates are unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  };

  const onDirectoryEvent = (root: string, directory: string, filename: string | Buffer | null) => {
    if (!filename) {
      invalidate(root);
      return;
    }
    const absolute = path.resolve(directory, String(filename));
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith("..") || relative.split(path.sep).includes(".git")) return;
    if (!isMarkdown(relative)) {
      if (watchers.get(root)?.has(absolute)) {
        invalidate(root);
        return;
      }
      void adoptDirectory(root, absolute).catch(() => {});
      return;
    }
    const observed = observeNow(root, relative);
    const saveWasActive = recentSaves.get(`${root}\0${relative}`)?.windowOpen === true;
    void ignored(git, root, relative).then((isIgnored) => {
      if (isIgnored) return;
      invalidate(root);
      void notify(root, relative, observed, saveWasActive);
    });
  };

  const watchDirectory = (root: string, directory: string) =>
    watch(directory, (_event, filename) => onDirectoryEvent(root, directory, filename));

  /** Watches a new directory and its subdirectories at once, so files written into them are seen. */
  const adoptDirectory = async (root: string, absolute: string): Promise<void> => {
    if (!(await fsp.stat(absolute)).isDirectory()) return;
    const relative = path.relative(root, absolute);
    if (await ignored(git, root, `${relative}${path.sep}`)) return;
    invalidate(root);
    const current = watchers.get(root);
    if (!current || activeRoot !== root || current.has(absolute)) return;
    try {
      current.set(absolute, watchDirectory(root, absolute));
    } catch (error) {
      unavailable(root, error);
      return;
    }
    const set = adopted.get(root) ?? new Set<string>();
    set.add(absolute);
    adopted.set(root, set);
    const entries = await fsp.readdir(absolute, { withFileTypes: true });
    await Promise.all(
      entries.flatMap((entry) =>
        entry.isDirectory() && entry.name !== ".git"
          ? [adoptDirectory(root, path.join(absolute, entry.name))]
          : [],
      ),
    );
  };

  /** Synchronous for the root only, so a request learns at once whether it is watched. */
  const startWatching = (root: string) => {
    if (activeRoot && activeRoot !== root) {
      closeWatchers(activeRoot);
      warnings.delete(root);
    }
    activeRoot = root;
    if (watchers.has(root) || warnings.has(root)) return;
    try {
      watchers.set(root, new Map([[root, watchDirectory(root, root)]]));
      warnings.set(root, null);
    } catch (error) {
      unavailable(root, error);
      return;
    }
    const files = listed.get(root);
    if (files) scheduleReconcile(root, files);
  };

  const reconcile = (root: string) => {
    const desired = reconciles.get(root);
    reconciles.delete(root);
    const current = watchers.get(root);
    if (!desired || !current || activeRoot !== root) return;
    const kept = adopted.get(root);
    for (const [directory, watcher] of current) {
      if (desired.has(directory)) {
        kept?.delete(directory);
        continue;
      }
      if (kept?.has(directory) && fs.existsSync(directory)) continue;
      kept?.delete(directory);
      watcher.close();
      current.delete(directory);
    }
    for (const directory of desired) {
      if (current.has(directory)) continue;
      try {
        current.set(directory, watchDirectory(root, directory));
      } catch (error) {
        unavailable(root, error);
        return;
      }
    }
  };

  const scheduleReconcile = (root: string, files: string[]) => {
    if (!watchers.has(root)) return;
    const pending = reconciles.has(root);
    reconciles.set(root, watchedDirectories(root, files));
    if (!pending) setImmediate(() => reconcile(root));
  };

  /** A change seen while listing leaves the cache empty, so the next request lists again. */
  const listTree = (root: string): Promise<VaultTreeNode[]> => {
    const inFlight = listings.get(root);
    if (inFlight) return inFlight;
    const generation = generations.get(root) ?? 0;
    const listing = (async () => {
      try {
        const files = await listMarkdownFiles(root, deps);
        listed.set(root, files);
        startWatching(root);
        scheduleReconcile(root, files);
        const tree = asTree(files);
        if ((generations.get(root) ?? 0) === generation) trees.set(root, tree);
        return tree;
      } finally {
        listings.delete(root);
      }
    })();
    listings.set(root, listing);
    return listing;
  };

  const readConflict = async (resolved: VaultPath, reason: string): Promise<VaultConflict> => {
    try {
      const content = await fsp.readFile(resolved.absolute, "utf8");
      return {
        kind: "conflict",
        path: resolved.relative,
        reason,
        content,
        token: versionToken(content),
      };
    } catch {
      return {
        kind: "conflict",
        path: resolved.relative,
        reason,
        content: "",
        token: versionToken(""),
      };
    }
  };

  const runSave = async (
    root: string,
    requestedPath: string,
    content: string,
    token?: string,
  ): Promise<VaultSaved | VaultConflict> => {
    const resolved = await resolveVaultPath(root, requestedPath);
    startWatching(root);
    await fsp.mkdir(path.dirname(resolved.absolute), { recursive: true });

    if (token === undefined) {
      const temporary = path.join(
        path.dirname(resolved.absolute),
        `.${path.basename(resolved.absolute)}.${randomUUID()}.tmp`,
      );
      await fsp.writeFile(temporary, content, "utf8");
      try {
        await deps.beforeWrite?.(resolved.absolute);
        await fsp.link(temporary, resolved.absolute);
      } catch (error) {
        await fsp.unlink(temporary).catch(() => {});
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return readConflict(resolved, "a file already exists at this path");
        }
        throw error;
      }
      await fsp.unlink(temporary).catch(() => {});
      const savedToken = versionToken(content);
      invalidate(root);
      return { kind: "saved", path: resolved.relative, token: savedToken };
    }

    let current: string;
    try {
      current = await fsp.readFile(resolved.absolute, "utf8");
    } catch {
      return readConflict(resolved, "the file no longer exists");
    }
    const currentToken = versionToken(current);
    if (currentToken !== token)
      return {
        kind: "conflict",
        path: resolved.relative,
        reason: "the file changed elsewhere",
        content: current,
        token: currentToken,
      };

    const savedToken = versionToken(content);
    const temporary = path.join(
      path.dirname(resolved.absolute),
      `.${path.basename(resolved.absolute)}.${randomUUID()}.tmp`,
    );
    const record: SaveRecord = {
      path: resolved.relative,
      content,
      token: savedToken,
      currentToken,
      windowOpen: true,
      expires: setTimeout(() => recentSaves.delete(`${root}\0${resolved.relative}`), 2_000),
    };
    recentSaves.set(`${root}\0${resolved.relative}`, record);
    try {
      await deps.beforeWrite?.(resolved.absolute);
      await fsp.writeFile(temporary, content, "utf8");
      await fsp.rename(temporary, resolved.absolute);
      record.windowOpen = false;
    } catch (error) {
      clearTimeout(record.expires);
      recentSaves.delete(`${root}\0${resolved.relative}`);
      await fsp.unlink(temporary).catch(() => {});
      throw error;
    }
    invalidate(root);
    return { kind: "saved", path: resolved.relative, token: savedToken };
  };

  const save = async (root: string, requestedPath: string, content: string, token?: string) => {
    const key = `${path.resolve(root)}\0${path.normalize(requestedPath)}`;
    const previous = locks.get(key) ?? Promise.resolve();
    const current = previous.then(async () => {
      const canonical = await resolveVaultPath(root, requestedPath);
      return runSave(canonical.root, canonical.relative, content, token);
    });
    locks.set(key, current);
    try {
      return await current;
    } finally {
      if (locks.get(key) === current) locks.delete(key);
    }
  };

  return {
    async tree(companionRoot, refresh = false) {
      const root = await rootKey(companionRoot);
      const tree = !refresh && trees.get(root);
      const result = tree || (await listTree(root));
      startWatching(root);
      return {
        tree: result,
        watching: watchers.has(root),
        warning: warnings.get(root) ?? null,
      };
    },
    async prefetch(companionRoot, refresh = false) {
      const root = await rootKey(companionRoot);
      if (refresh) invalidate(root);
      startWatching(root);
      const tree = trees.get(root);
      if (tree) return { tree, watching: watchers.has(root), warning: warnings.get(root) ?? null };
      void listTree(root).catch(() => {});
      return null;
    },
    async open(companionRoot, requestedPath) {
      const root = await rootKey(companionRoot);
      startWatching(root);
      return readVaultFile(root, requestedPath);
    },
    save,
    subscribe(companionRoot, requestedPath, notifySubscriber) {
      let active = true;
      let key = `${path.resolve(companionRoot)}\0${requestedPath}`;
      const subscriber = { path: requestedPath, notify: notifySubscriber };
      const set = subscribers.get(key) ?? new Set<Subscriber>();
      set.add(subscriber);
      subscribers.set(key, set);
      const watchListed = (root: string) => {
        startWatching(root);
        if (!trees.has(root)) void listTree(root).catch(() => {});
      };
      void rootKey(companionRoot).then((root) => {
        if (!active || root === path.resolve(companionRoot)) {
          if (active) watchListed(root);
          return;
        }
        const oldSet = subscribers.get(key);
        oldSet?.delete(subscriber);
        if (oldSet?.size === 0) subscribers.delete(key);
        key = `${root}\0${requestedPath}`;
        const newSet = subscribers.get(key) ?? new Set<Subscriber>();
        newSet.add(subscriber);
        subscribers.set(key, newSet);
        watchListed(root);
      });
      return () => {
        active = false;
        const currentSubscribers = subscribers.get(key);
        if (!currentSubscribers) return;
        currentSubscribers.delete(subscriber);
        if (currentSubscribers.size === 0) subscribers.delete(key);
      };
    },
    async refresh(companionRoot) {
      return this.tree(companionRoot, true);
    },
    deactivate() {
      if (activeRoot) {
        closeWatchers(activeRoot);
        warnings.delete(activeRoot);
      }
      activeRoot = null;
      subscribers.clear();
    },
    stop() {
      for (const root of watchers.keys()) closeWatchers(root);
      reconciles.clear();
      activeRoot = null;
      for (const timer of pendingEvents.values()) clearTimeout(timer);
      for (const record of recentSaves.values()) clearTimeout(record.expires);
      pendingEvents.clear();
      recentSaves.clear();
      subscribers.clear();
    },
    getRecovery(companionRoot, requestedPath) {
      const root = path.resolve(companionRoot);
      return (
        recoveries.get(`${root}\0${requestedPath}`) ??
        [...recoveries.entries()].find(
          ([key]) => key.startsWith(`${root}\0`) && key.endsWith(`\0${requestedPath}`),
        )?.[1] ??
        [...recoveries.values()].find((event) => event.path === requestedPath) ??
        null
      );
    },
  };
}
