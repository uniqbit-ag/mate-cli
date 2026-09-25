import { createHash, randomUUID } from "node:crypto";
import fs, { type Dirent, type FSWatcher, type Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

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

export interface VaultDeps {
  watch?: (
    root: string,
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

async function ignored(root: string, relative: string): Promise<boolean> {
  try {
    await execFile("git", ["-C", root, "check-ignore", "--no-index", "--quiet", "--", relative]);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(
  root: string,
  current: string,
  relativeDir: string,
  output: string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const relative = path.join(relativeDir, entry.name);
    if (await ignored(root, relative)) continue;
    const absolute = path.join(current, entry.name);
    let resolved: string;
    try {
      resolved = await fsp.realpath(absolute);
      if (!inside(root, resolved)) continue;
    } catch {
      continue;
    }
    let stats: Stats;
    try {
      stats = await fsp.stat(resolved);
    } catch {
      continue;
    }
    if (stats.isDirectory()) await collectFiles(root, resolved, relative, output);
    else if (stats.isFile() && isMarkdown(relative)) output.push(relative);
  }
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
export async function collectMarkdownTree(companionRoot: string): Promise<VaultTreeNode[]> {
  const root = await fsp.realpath(companionRoot);
  const files: string[] = [];
  await collectFiles(root, root, "", files);
  return asTree(files);
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
  root: string,
  listener: (event: string, filename: string | Buffer | null) => void,
): VaultWatcher {
  const watcher: FSWatcher = fs.watch(root, { recursive: true }, listener);
  return { close: () => watcher.close() };
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

/** Owns one tree cache and one recursive watcher per selected companion process. */
export function createVaultManager(deps: VaultDeps = {}): VaultManager {
  const watch = deps.watch ?? defaultWatcher;
  const trees = new Map<string, VaultTreeNode[]>();
  const warnings = new Map<string, string | null>();
  const watchers = new Map<string, VaultWatcher>();
  let activeRoot: string | null = null;
  const subscribers = new Map<string, Set<Subscriber>>();
  const pendingEvents = new Map<string, ReturnType<typeof setTimeout>>();
  const locks = new Map<string, Promise<unknown>>();
  const recentSaves = new Map<string, SaveRecord>();
  const recoveries = new Map<string, VaultWatchEvent>();

  const rootKey = async (root: string) => fsp.realpath(root);

  const invalidate = (root: string) => {
    trees.delete(root);
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

  const startWatching = (root: string) => {
    if (activeRoot && activeRoot !== root) {
      watchers.get(activeRoot)?.close();
      watchers.delete(activeRoot);
      warnings.delete(root);
    }
    activeRoot = root;
    if (watchers.has(root) || warnings.has(root)) return;
    try {
      watchers.set(
        root,
        watch(root, (_event, filename) => {
          if (!filename) return;
          const value = String(filename);
          const relative = path.relative(
            root,
            path.isAbsolute(value) ? value : path.resolve(root, value),
          );
          if (
            !relative ||
            relative.startsWith("..") ||
            !isMarkdown(relative) ||
            relative.split(path.sep).includes(".git")
          )
            return;
          const observed = observeNow(root, relative);
          const saveWasActive = recentSaves.get(`${root}\0${relative}`)?.windowOpen === true;
          void ignored(root, relative).then((isIgnored) => {
            if (isIgnored) return;
            invalidate(root);
            void notify(root, relative, observed, saveWasActive);
          });
        }),
      );
      warnings.set(root, null);
    } catch (error) {
      warnings.set(
        root,
        `Live updates are unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
      startWatching(root);
      if (refresh || !trees.has(root)) trees.set(root, await collectMarkdownTree(root));
      return {
        tree: trees.get(root) ?? [],
        watching: watchers.has(root),
        warning: warnings.get(root) ?? null,
      };
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
      void rootKey(companionRoot).then((root) => {
        if (!active || root === path.resolve(companionRoot)) {
          if (active) startWatching(root);
          return;
        }
        const oldSet = subscribers.get(key);
        oldSet?.delete(subscriber);
        if (oldSet?.size === 0) subscribers.delete(key);
        key = `${root}\0${requestedPath}`;
        const newSet = subscribers.get(key) ?? new Set<Subscriber>();
        newSet.add(subscriber);
        subscribers.set(key, newSet);
        startWatching(root);
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
        watchers.get(activeRoot)?.close();
        watchers.delete(activeRoot);
        warnings.delete(activeRoot);
      }
      activeRoot = null;
      subscribers.clear();
    },
    stop() {
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
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
