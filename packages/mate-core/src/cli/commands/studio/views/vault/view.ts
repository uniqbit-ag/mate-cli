import { errorMessage } from "../../../../../runtime/error-message";
import type { VaultManager, VaultTreeNode } from "../../vault";
import { markdownTree, type MdNode } from "./markdown-tree";

/**
 * A tree entry as the browser gets it: a folder carries its entries only when it is on the
 * open path, so what crosses to the page depends on the entries shown, not on the
 * repository's size.
 */
export interface VaultEntry {
  name: string;
  /** Companion-relative, `/`-separated. */
  path: string;
  kind: "file" | "directory";
  /** Present only for an expanded folder. */
  children?: VaultEntry[];
}

export interface VaultOpenFile {
  path: string;
  content: string;
  token: string;
  /** The content rendered on the server; links already resolved. */
  markdown: MdNode[];
}

export interface VaultView {
  /** `null` while the listing still runs; the page asks again with `wait`. */
  tree: VaultEntry[] | null;
  generation: number | null;
  watching: boolean;
  warning: string | null;
  failure: string | null;
  /** The requested folder, or `null` when none was named or the tree does not hold it. */
  dir: string | null;
  /** Whether a named folder was missing from the listed tree. */
  dirMissing: boolean;
  open: VaultOpenFile | null;
  refusal: string | null;
}

export interface VaultViewRequest {
  path?: string;
  dir?: string;
  refresh?: boolean;
  /** Waits for the listing instead of answering without it. */
  wait?: boolean;
}

/** Most matches a filter shows; the rest are counted, not sent. */
export const VAULT_FILTER_LIMIT = 200;

const segments = (relative: string): string[] => relative.split(/[\\/]/).filter(Boolean);
const key = (relative: string): string => segments(relative).join("/");

function byKindThenName(a: VaultTreeNode, b: VaultTreeNode): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** Folders on the path to the open file (not the file itself) and to the open folder. */
function expandedPaths(path: string | null, dir: string | null): Set<string> {
  const expanded = new Set<string>();
  const add = (relative: string, includeLast: boolean) => {
    const parts = segments(relative);
    const count = includeLast ? parts.length : parts.length - 1;
    for (let index = 1; index <= count; index += 1) expanded.add(parts.slice(0, index).join("/"));
  };
  if (path) add(path, false);
  if (dir) add(dir, true);
  return expanded;
}

/** Sorted entries, folders first; only expanded folders keep theirs. */
function pruneTree(nodes: VaultTreeNode[], expanded: Set<string>): VaultEntry[] {
  return nodes.toSorted(byKindThenName).map((node) => {
    const path = key(node.path);
    const entry: VaultEntry = { name: node.name, path, kind: node.kind };
    if (node.kind === "directory" && expanded.has(path)) {
      entry.children = pruneTree(node.children ?? [], expanded);
    }
    return entry;
  });
}

/** Walks node names, so a requested folder is only ever one the listed tree holds. */
function findDirectory(tree: VaultTreeNode[], relative: string): VaultTreeNode | null {
  let level = tree;
  let found: VaultTreeNode | null = null;
  for (const name of segments(relative)) {
    found = level.find((node) => node.kind === "directory" && node.name === name) ?? null;
    if (!found) return null;
    level = found.children ?? [];
  }
  return found;
}

/** An open file with its rendered form, or the vault's refusal. */
export async function vaultFile(
  manager: VaultManager,
  companionPath: string,
  path: string,
): Promise<{ open: VaultOpenFile | null; refusal: string | null }> {
  try {
    const file = await manager.open(companionPath, path);
    const relative = key(file.path);
    return {
      open: { ...file, path: relative, markdown: markdownTree(file.content, relative) },
      refusal: null,
    };
  } catch (error) {
    return { open: null, refusal: errorMessage(error) };
  }
}

/** One vault page's state: the bounded tree, the open folder or file. */
export async function vaultView(
  manager: VaultManager,
  companionPath: string,
  request: VaultViewRequest,
): Promise<VaultView> {
  const path = request.path ? key(request.path) : null;
  const dir = request.dir ? key(request.dir) : null;
  let failure: string | null = null;
  let listed: Awaited<ReturnType<VaultManager["tree"]>> | null = null;
  try {
    listed = request.wait
      ? await manager.tree(companionPath, request.refresh)
      : await manager.prefetch(companionPath, request.refresh);
  } catch (error) {
    failure = errorMessage(error);
  }
  const file = path ? await vaultFile(manager, companionPath, path) : { open: null, refusal: null };
  const found = listed && dir ? findDirectory(listed.tree, dir) : null;
  return {
    tree: listed ? pruneTree(listed.tree, expandedPaths(path, dir)) : null,
    generation: listed?.generation ?? null,
    watching: listed?.watching ?? false,
    warning: listed?.warning ?? null,
    failure,
    dir: found ? dir : null,
    dirMissing: Boolean(listed && dir && !found),
    ...file,
  };
}

/** A folder's entries when the viewer first expands it; `null` when the listed tree lacks it. */
export async function vaultChildren(
  manager: VaultManager,
  companionPath: string,
  dir: string,
): Promise<{ entries: VaultEntry[]; generation: number } | null> {
  const listed = await manager.tree(companionPath);
  const folder = findDirectory(listed.tree, dir);
  if (!folder) return null;
  return { entries: pruneTree(folder.children ?? [], new Set()), generation: listed.generation };
}

/** Files whose path contains `query`, over the whole listed tree, bounded; never touches the disk. */
export async function vaultMatches(
  manager: VaultManager,
  companionPath: string,
  query: string,
): Promise<{ shown: VaultEntry[]; total: number; generation: number }> {
  const listed = await manager.tree(companionPath);
  const needle = query.trim().toLowerCase();
  const shown: VaultEntry[] = [];
  let total = 0;
  if (!needle) return { shown, total, generation: listed.generation };
  const stack = listed.tree.toReversed();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.kind === "directory") {
      for (let index = (node.children?.length ?? 0) - 1; index >= 0; index -= 1) {
        stack.push(node.children![index]!);
      }
    } else if (key(node.path).toLowerCase().includes(needle)) {
      total += 1;
      if (shown.length < VAULT_FILTER_LIMIT) {
        shown.push({ name: node.name, path: key(node.path), kind: "file" });
      }
    }
  }
  return { shown, total, generation: listed.generation };
}
