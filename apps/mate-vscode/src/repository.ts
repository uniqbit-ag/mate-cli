import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isWorksetBranch, parseWorktrees, type Worktree } from "./worktrees";

const run = promisify(execFile);

export interface UmbrellaChild {
  path: string;
  /** `org/repository` of the child's `origin`; absent without one. */
  id?: string;
}

/**
 * The window's repository: a Git checkout, or an Umbrella Repository (also a mirrored
 * umbrella worktree) whose direct children are the checkouts.
 */
export type WindowRepository =
  | { kind: "checkout"; root: string }
  | { kind: "umbrella"; root: string; children: UmbrellaChild[] };

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

/** A repo-local Mate link. */
function linkRegistryPath(folder: string): string {
  return path.join(folder, ".mate", "config", "registry.yaml");
}

/** Raw config, not `remote get-url`, so `insteadOf` rewrites keep Mate's identity. */
async function rawOriginId(checkout: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["config", "--get", "remote.origin.url"], {
      cwd: checkout,
    });
    return repositoryIdOf(stdout);
  } catch {
    return null;
  }
}

/**
 * The umbrella's children at `folder`, in name order; empty when it is no umbrella. Mirrors
 * mate-core's rule: `folder` has no Git layout and a repo-local link; children are direct
 * folders with a Git layout and no link of their own.
 */
async function umbrellaChildren(folder: string): Promise<UmbrellaChild[]> {
  if ((await exists(path.join(folder, ".git"))) || !(await exists(linkRegistryPath(folder)))) {
    return [];
  }
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
  const children = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map(async (entry): Promise<UmbrellaChild | null> => {
        const child = path.join(folder, entry.name);
        if (!(await exists(path.join(child, ".git")))) return null;
        if (await exists(linkRegistryPath(child))) return null;
        const id = await rawOriginId(child);
        return id ? { path: child, id } : { path: child };
      }),
  );
  return (
    children
      .filter((child): child is UmbrellaChild => child !== null)
      // Code-unit order, as mate-core picks a mirrored worktree's branch.
      // oxlint-disable-next-line unicorn/no-array-sort -- engines.vscode 1.85 runs Node 18, which lacks toSorted
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  );
}

/** The nearest linked ancestor-or-self of `folder`, when it is an umbrella; as mate-core. */
async function umbrellaAt(folder: string): Promise<WindowRepository | null> {
  for (let current = folder; ;) {
    if (await exists(linkRegistryPath(current))) {
      const children = await umbrellaChildren(current);
      return children.length > 0 ? { kind: "umbrella", root: current, children } : null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The Git checkout containing `folder`, else the umbrella holding it, else null. */
export async function resolveRepository(
  folder: string | undefined,
): Promise<WindowRepository | null> {
  if (!folder) return null;
  try {
    const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], { cwd: folder });
    const root = stdout.trim();
    if (root) return { kind: "checkout", root };
  } catch {
    // Outside Git: maybe an umbrella.
  }
  // Canonical like `--show-toplevel`: Mate records session folders as real paths.
  return umbrellaAt(await fs.realpath(folder).catch(() => folder));
}

/** Mirrored umbrella worktrees `<umbrella>.worktrees/*`, in name order. */
async function mirroredWorktrees(umbrella: string): Promise<string[]> {
  const parent = `${umbrella}.worktrees`;
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
  const mirrored = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const folder = path.join(parent, entry.name);
        return (await isLinkedNonGitFolder(folder)) ? folder : null;
      }),
  );
  return (
    mirrored
      .filter((folder): folder is string => folder !== null)
      // oxlint-disable-next-line unicorn/no-array-sort -- engines.vscode 1.85 runs Node 18, which lacks toSorted
      .sort()
  );
}

/** A linked folder without a Git layout: an umbrella or its mirrored worktree. */
async function isLinkedNonGitFolder(folder: string): Promise<boolean> {
  return !(await exists(path.join(folder, ".git"))) && (await exists(linkRegistryPath(folder)));
}

async function worktreesOf(checkout: string): Promise<string[]> {
  return (await listWorktrees(checkout).catch(() => [])).map((worktree) => worktree.path);
}

/**
 * Folders whose sessions belong to the window's repository: a checkout's worktrees, or
 * the umbrella, its children, their worktrees, and its mirrored worktrees.
 */
export async function repositoryRoots(repository: WindowRepository): Promise<string[]> {
  if (repository.kind === "checkout") {
    const worktrees = await worktreesOf(repository.root);
    return worktrees.length > 0 ? worktrees : [repository.root];
  }
  const [children, mirrored] = await Promise.all([
    Promise.all(
      repository.children.map(async (child) => [child.path, ...(await worktreesOf(child.path))]),
    ),
    mirroredWorktrees(repository.root),
  ]);
  return [...new Set([repository.root, ...children.flat(), ...mirrored])];
}

export interface UmbrellaWorktrees {
  /** Mirrored worktrees, each with the branch its children hold. */
  mirrored: Worktree[];
  /** Each child's other worktrees, without its main checkout or those inside a mirrored one. */
  children: { name: string; worktrees: Worktree[] }[];
}

/** One worktree list per child; mirrored branches come from those lists too. */
export async function umbrellaWorktrees(
  repository: Extract<WindowRepository, { kind: "umbrella" }>,
  worksetBranches?: ReadonlySet<string>,
): Promise<UmbrellaWorktrees> {
  const [folders, lists] = await Promise.all([
    mirroredWorktrees(repository.root),
    Promise.all(
      repository.children.map((child) =>
        listWorktrees(child.path, worksetBranches).catch((): Worktree[] => []),
      ),
    ),
  ]);
  // Children in name order: the first attached child's branch wins, as in mate-core.
  const childWorktrees = lists.flatMap((list) => list.slice(1));
  // Git keeps the path it was given, real or not.
  const reals = await Promise.all(folders.map((folder) => fs.realpath(folder).catch(() => folder)));
  const inMirrored = new Set([...folders, ...reals]);
  const mirrored = folders.map((folder, at): Worktree => {
    const branch = childWorktrees.find((worktree) => {
      const parent = path.dirname(worktree.path);
      return (parent === reals[at] || parent === folder) && worktree.branch;
    })?.branch;
    return {
      path: folder,
      ...(branch ? { branch } : {}),
      workset: isWorksetBranch(branch, worksetBranches),
    };
  });
  const children = repository.children.map((child, at) => ({
    name: path.basename(child.path),
    worktrees: lists[at]!.slice(1).filter(
      (worktree) => worktree.path !== child.path && !inMirrored.has(path.dirname(worktree.path)),
    ),
  }));
  return { mirrored, children: children.filter((child) => child.worktrees.length > 0) };
}

export async function listWorktrees(
  repoRoot: string,
  worksetBranches?: ReadonlySet<string>,
): Promise<Worktree[]> {
  const { stdout } = await run("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  return parseWorktrees(stdout, worksetBranches);
}

/** `org/repository` from a Git remote URL (SSH or HTTPS), keeping nested groups. */
export function repositoryIdOf(remoteUrl: string): string | null {
  const trimmed = remoteUrl
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  const scp = /^[^@/]+@[^:]+:(.+)$/.exec(trimmed);
  if (scp) return scp[1]!;
  try {
    const url = new URL(trimmed);
    return url.pathname.replace(/^\//, "") || null;
  } catch {
    return null;
  }
}

/** The `origin` remote's `org/repository`, or null without one. */
export function repositoryId(repoRoot: string): Promise<string | null> {
  return rawOriginId(repoRoot);
}

/** `origin/HEAD`'s branch, else `main`. */
export async function defaultBranch(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await run(
      "git",
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      { cwd: repoRoot },
    );
    return stdout.trim().replace(/^origin\//, "") || "main";
  } catch {
    return "main";
  }
}
