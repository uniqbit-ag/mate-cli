import fs from "node:fs";
import path from "node:path";

/**
 * A Checkout's Git layout, read from files alone: no `git` process, no
 * inherited `GIT_*` variables, callable from synchronous code. Every path is
 * real, so callers may compare them directly.
 *
 * Known limits: a worktree of a `--separate-git-dir` clone finds that clone's
 * checkout only through `core.worktree`, since no other file records it; and
 * only the shared `config` is read, not its `include`s or `config.worktree`.
 */

/**
 * `main`: `.git` is a folder. `linked`: a worktree whose Git folder names a
 * shared one through `commondir`. `own`: `.git` points to a Git folder that
 * names no shared one, as a submodule's or a `--separate-git-dir` clone's.
 */
export type GitLayoutKind = "main" | "linked" | "own";

export interface GitLayout {
  kind: GitLayoutKind;
  /** The Checkout's own Git folder. */
  gitDir: string;
  /** The folder all Checkouts of the clone share; Git reads `info/exclude` only here. */
  commonDir: string;
}

export function realPath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/** `stat`, or null for a path that is missing or runs through a file (`ENOTDIR`). */
function statOf(candidate: string): fs.Stats | null {
  try {
    return fs.statSync(candidate);
  } catch {
    return null;
  }
}

export function isDirectory(candidate: string): boolean {
  return statOf(candidate)?.isDirectory() ?? false;
}

/** The folder a `.git` file names, resolved against the file's own folder. */
function gitFileTarget(dotGit: string): string | null {
  const match = readText(dotGit)?.match(/^gitdir:\s*(.+?)\s*$/m);
  return match ? path.resolve(path.dirname(dotGit), match[1]) : null;
}

/** A one-line file whose path value is resolved against `base`. */
function readPathFile(filePath: string, base: string): string | null {
  const value = readText(filePath)?.trim();
  return value ? path.resolve(base, value) : null;
}

export function readGitLayout(checkoutPath: string): GitLayout | null {
  /** Real first: a relative `gitdir:` is relative to where `.git` really is. */
  const dotGit = path.join(realPath(checkoutPath), ".git");
  const stat = statOf(dotGit);
  if (stat?.isDirectory()) {
    const gitDir = realPath(dotGit);
    return { kind: "main", gitDir, commonDir: gitDir };
  }
  if (!stat?.isFile()) return null;
  const target = gitFileTarget(dotGit);
  if (!target || !isDirectory(target)) return null;
  const gitDir = realPath(target);
  const commonDir = readPathFile(path.join(gitDir, "commondir"), gitDir);
  return commonDir && isDirectory(commonDir)
    ? { kind: "linked", gitDir, commonDir: realPath(commonDir) }
    : { kind: "own", gitDir, commonDir: gitDir };
}

const CONFIG_ESCAPES: Record<string, string> = { n: "\n", t: "\t" };

/** A config value without its comment, quotes and escapes, as Git reads it. */
function configValue(raw: string): string {
  let value = "";
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "\\") {
      const next = raw[index + 1] ?? "";
      value += CONFIG_ESCAPES[next] ?? next;
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && (char === "#" || char === ";")) {
      break;
    } else {
      value += char;
    }
  }
  return value.trim();
}

/** `[core]` values from a Git config file; enough for `bare` and `worktree`. */
function coreConfig(commonDir: string): Map<string, string> {
  const values = new Map<string, string>();
  let inCore = false;
  for (const raw of (readText(path.join(commonDir, "config")) ?? "").split(/\r?\n/)) {
    let line = raw.trim();
    /** `[core]` only: `[core "x"]` is a subsection, and a key may follow the header. */
    const section = /^\[\s*([A-Za-z0-9.-]+)\s*("(?:[^"\\]|\\.)*")?\s*\](.*)$/.exec(line);
    if (section) {
      inCore = section[1].toLowerCase() === "core" && section[2] === undefined;
      line = section[3].trim();
    }
    const entry = inCore ? /^([A-Za-z][\w-]*)\s*(?:=(.*)|[#;].*)?$/.exec(line) : null;
    if (!entry) continue;
    /** A key with no `=` is a true boolean. */
    values.set(entry[1].toLowerCase(), entry[2] === undefined ? "true" : configValue(entry[2]));
  }
  return values;
}

/** Git's spellings of true: `true`, `yes`, `on`, any non-zero number. */
function configTrue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const lower = value.toLowerCase();
  if (["true", "yes", "on"].includes(lower)) return true;
  return /^-?\d+$/.test(lower) && Number(lower) !== 0;
}

/**
 * The worktree whose `.git` is the shared folder itself, else `core.worktree`;
 * none for a bare repository.
 */
function mainWorktree(
  commonDir: string,
  core: Map<string, string> = coreConfig(commonDir),
): string | null {
  if (configTrue(core.get("bare"))) return null;
  const configured = core.get("worktree");
  if (configured) {
    const worktree = path.resolve(commonDir, configured);
    return isDirectory(worktree) ? realPath(worktree) : null;
  }
  const parent = path.dirname(commonDir);
  const layout = readGitLayout(parent);
  return layout && layout.gitDir === commonDir ? realPath(parent) : null;
}

/**
 * The exclude file Git reads for a Checkout: the shared Git folder's, never a
 * linked worktree's private one. `null` outside Git.
 */
export function gitExcludePath(checkoutPath: string): string | null {
  const layout = readGitLayout(checkoutPath);
  return layout ? path.join(layout.commonDir, "info", "exclude") : null;
}

/**
 * Each record under the shared folder's `worktrees/` whose worktree still
 * points back to it, or that is locked: Git keeps a locked worktree registered
 * while its drive is away. Sorted by record name.
 */
function worktreeRecords(commonDir: string): LinkedWorktree[] {
  const adminRoot = path.join(commonDir, "worktrees");
  let names: string[];
  try {
    names = fs.readdirSync(adminRoot).toSorted();
  } catch {
    return [];
  }
  return names.flatMap((recordName) => {
    const adminDir = path.join(adminRoot, recordName);
    const dotGit = readPathFile(path.join(adminDir, "gitdir"), adminDir);
    if (!dotGit || path.basename(dotGit) !== ".git") return [];
    const checkout = path.dirname(dotGit);
    const live = readGitLayout(checkout)?.gitDir === realPath(adminDir);
    if (!live && !fs.existsSync(path.join(adminDir, "locked"))) return [];
    return [{ recordName, path: realPath(checkout), live }];
  });
}

function linkedWorktrees(commonDir: string): string[] {
  return worktreeRecords(commonDir).map((record) => record.path);
}

/**
 * The clone's other live Checkouts: its main worktree and each linked worktree
 * that still points back or is locked. A locked one may be unreachable.
 * Empty when the layout cannot be read.
 */
export function otherCheckouts(checkoutPath: string): string[] {
  const layout = readGitLayout(checkoutPath);
  if (!layout) return [];
  const self = realPath(checkoutPath);
  const main = layout.kind === "linked" ? mainWorktree(layout.commonDir) : self;
  return [...(main ? [main] : []), ...linkedWorktrees(layout.commonDir)].filter(
    (checkout) => checkout !== self,
  );
}

/** A Checkout root and its layout. */
export interface CheckoutRoot {
  root: string;
  layout: GitLayout;
}

/**
 * The nearest folder at or above `folder` whose Git layout reads, as Git finds
 * its repository: a nested worktree or a submodule is its own root. `null`
 * outside Git.
 */
export function checkoutRootOf(folder: string): CheckoutRoot | null {
  let dir = realPath(folder);
  for (;;) {
    const layout = readGitLayout(dir);
    if (layout) return { root: dir, layout };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A linked worktree as its clone lists it. */
export interface LinkedWorktree {
  recordName: string;
  path: string;
  /** Its `.git` file points back; a locked worktree whose folder is away is listed but not live. */
  live: boolean;
}

/** The Checkouts that share one Git folder. */
export interface Clone {
  commonDir: string;
  bare: boolean;
  /** `null` for a bare repository. */
  mainWorktree: string | null;
  /** By record name: each live worktree, and each locked one whose folder is away. */
  linkedWorktrees: LinkedWorktree[];
}

function isGitFolder(dir: string): boolean {
  return isDirectory(dir) && fs.existsSync(path.join(dir, "HEAD"));
}

/** The clone whose shared Git folder is `commonDir`; `null` when that is no Git folder. */
export function cloneAt(commonDir: string): Clone | null {
  const dir = realPath(commonDir);
  if (!isGitFolder(dir)) return null;
  const core = coreConfig(dir);
  const bare = configTrue(core.get("bare"));
  return {
    commonDir: dir,
    bare,
    mainWorktree: bare ? null : mainWorktree(dir, core),
    linkedWorktrees: worktreeRecords(dir),
  };
}

/** The main worktree of the clone at `commonDir`, without listing its worktrees. */
export function mainWorktreeOf(commonDir: string): string | null {
  const dir = realPath(commonDir);
  return isGitFolder(dir) ? mainWorktree(dir) : null;
}

/**
 * The clone's live Checkouts in the order a handover or a borrow tries them:
 * the main worktree, then each linked worktree that points back, by record
 * name. Lazy, so a caller that takes the main worktree lists no records.
 */
export function* liveCheckouts(commonDir: string): Generator<string> {
  const dir = realPath(commonDir);
  if (!isGitFolder(dir)) return;
  const main = mainWorktree(dir);
  if (main && isDirectory(main)) yield main;
  for (const record of worktreeRecords(dir)) if (record.live) yield record.path;
}

/**
 * The clone of the Checkout at `root`. `null` for an `own` layout (a submodule,
 * a separate Git folder), which is the Checkout of no shared clone, and outside Git.
 */
export function cloneOf(root: string): Clone | null {
  const layout = readGitLayout(root);
  if (!layout || layout.kind === "own") return null;
  return cloneAt(layout.commonDir);
}

/**
 * The shared Git folder of the Checkout at `root` when it counts as one of its
 * clone: a main worktree, or a linked worktree whose record points back to it.
 */
export function checkoutCommonDir(root: string): string | null {
  const layout = readGitLayout(root);
  if (!layout || layout.kind === "own") return null;
  if (layout.kind === "main") return layout.commonDir;
  const dotGit = readPathFile(path.join(layout.gitDir, "gitdir"), layout.gitDir);
  if (!dotGit || path.basename(dotGit) !== ".git") return null;
  return realPath(path.dirname(dotGit)) === realPath(root) ? layout.commonDir : null;
}

/** Two Checkout roots of one clone, compared by the real path of their shared Git folder. */
export function sameClone(a: string, b: string): boolean {
  const first = checkoutCommonDir(a);
  return first !== null && first === checkoutCommonDir(b);
}

/**
 * The Checkout a session for `repositoryPath` serves from `folder` (design
 * Decision 11): the root of the Checkout holding `folder` when that is another
 * live Checkout of the same clone, else `repositoryPath`.
 */
export function checkoutServedFrom(repositoryPath: string, folder: string): string {
  const root = checkoutRootOf(folder)?.root;
  return root && namesOtherCheckout(root, repositoryPath) ? root : repositoryPath;
}

/**
 * `named` is another live Checkout of `root`'s clone, as when a `.mate/` folder
 * was copied from it: such a link or projection belongs to `named`, not `root`.
 */
export function namesOtherCheckout(root: string, named: string): boolean {
  const self = realPath(root);
  const other = realPath(named);
  return self !== other && isDirectory(other) && sameClone(self, other);
}
