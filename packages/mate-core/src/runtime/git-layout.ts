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

function realPath(candidate: string): string {
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

function isDirectory(candidate: string): boolean {
  return fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory() ?? false;
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
  const stat = fs.statSync(dotGit, { throwIfNoEntry: false });
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
function mainWorktree(commonDir: string): string | null {
  const core = coreConfig(commonDir);
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
 * Each worktree the shared folder lists whose `.git` file still points back to
 * it, and each locked one: Git keeps a locked worktree registered while its
 * drive is away, and so does this list.
 */
function linkedWorktrees(commonDir: string): string[] {
  const adminRoot = path.join(commonDir, "worktrees");
  let names: string[];
  try {
    names = fs.readdirSync(adminRoot).toSorted();
  } catch {
    return [];
  }
  const worktrees: string[] = [];
  for (const name of names) {
    const adminDir = path.join(adminRoot, name);
    const dotGit = readPathFile(path.join(adminDir, "gitdir"), adminDir);
    if (!dotGit || path.basename(dotGit) !== ".git") continue;
    const checkout = path.dirname(dotGit);
    const live = readGitLayout(checkout)?.gitDir === realPath(adminDir);
    if (live || fs.existsSync(path.join(adminDir, "locked"))) worktrees.push(realPath(checkout));
  }
  return worktrees;
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
