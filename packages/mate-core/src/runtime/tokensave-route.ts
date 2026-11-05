import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { checkoutRootOf, isSameClone, readGitLayout } from "./git-layout";

/**
 * Routes tokensave tool calls to a linked worktree's own index. The MCP server
 * stays bound to the checkout the session started in, which may itself be a
 * linked worktree; a per-call `graph_root` is tokensave's own way to query
 * another initialised project, read-only. tokensave rejects a `graph_root`
 * naming the served project, so that checkout is never routed.
 */

/** The tokensave store's database, relative to a checkout root. */
export const TOKENSAVE_DB = path.join(".tokensave", "tokensave.db");

/** Touched when routing last synced a worktree's index; its mtime throttles the next sync. */
export const ROUTE_SYNC_MARKER = path.join(".tokensave", "mate-route-synced");

/** At most one routed sync per worktree in this window. */
const SYNC_INTERVAL_MS = 30_000;
const SYNC_TIMEOUT_MS = 10_000;

/**
 * Graph query tools that take `graph_root`. Edit, git, memory, branch and
 * config tools do not: they keep acting on the served checkout.
 */
const GRAPH_ROOT_TOOLS = new Set([
  "annotations",
  "ambiguous_calls",
  "body",
  "by_qualified_name",
  "call_chain",
  "callees",
  "callers",
  "callers_for",
  "circular",
  "complexity",
  "constructors",
  "context",
  "coupling",
  "dead_code",
  "dependency_depth",
  "derives",
  "distribution",
  "doc",
  "doc_coverage",
  "dsm",
  "entities",
  "field_sites",
  "file_dependents",
  "files",
  "find_exact_symbol",
  "gini",
  "god_class",
  "health",
  "hotspots",
  "impact",
  "implementations",
  "impls",
  "imports",
  "inheritance_depth",
  "largest",
  "module_api",
  "node",
  "rank",
  "read",
  "recursion",
  "search",
  "signature",
  "signature_search",
  "similar",
  "status",
  "test_coverage",
  "test_map",
  "test_risk",
  "todos",
  "type_hierarchy",
  "unsafe_patterns",
  "unused_imports",
]);

/**
 * True for a tokensave graph query that takes `graph_root`, by the name Claude
 * (`mcp__tokensave__tokensave_<tool>`) or OpenCode (`tokensave_tokensave_<tool>`) gives it.
 */
export function isRoutableTokensaveTool(tool: string): boolean {
  const match = /^(?:mcp__tokensave__|tokensave_)tokensave_([a-z_]+)$/.exec(tool);
  return match !== null && GRAPH_ROOT_TOOLS.has(match[1]!);
}

export interface RouteDeps {
  /** Brings the worktree's index up to date; the default runs `tokensave sync`, throttled. */
  refresh?: (root: string) => void;
  /** The session's start directory: its checkout is the one the MCP server serves. */
  servedDirectory?: string;
}

/**
 * Runs `tokensave sync` in `root` unless it ran within {@link SYNC_INTERVAL_MS}. Nothing
 * else keeps a worktree's index fresh: the MCP server watches only the served checkout.
 * Bounded and silent; a failure leaves the index as it was.
 */
export function refreshWorktreeIndex(root: string): void {
  const marker = path.join(root, ROUTE_SYNC_MARKER);
  const last = fs.statSync(marker, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  if (Date.now() - last < SYNC_INTERVAL_MS) return;
  // Touched first, so a failing or slow sync is not retried on every call.
  fs.writeFileSync(marker, "");
  spawnSync("tokensave", ["sync"], { cwd: root, stdio: "ignore", timeout: SYNC_TIMEOUT_MS });
}

/**
 * `input` with `graph_root` set to the linked worktree containing `directory`,
 * when `tool` takes `graph_root`, `input` names none, the worktree holds a
 * tokensave index and is not the served checkout; the index is refreshed
 * first. Otherwise, and on any error, `undefined`: the call passes unchanged.
 */
export function routeTokensaveInput(
  tool: string,
  directory: string,
  input: unknown,
  deps: RouteDeps = {},
): Record<string, unknown> | undefined {
  try {
    if (!isRoutableTokensaveTool(tool)) return undefined;
    // A tool with no arguments sends none; anything else must be an arguments object.
    const given = input === undefined ? {} : input;
    if (given === null || typeof given !== "object" || Array.isArray(given)) return undefined;
    const args = given as Record<string, unknown>;
    if (args.graph_root !== undefined && args.graph_root !== null) return undefined;
    const root = checkoutRootOf(directory);
    if (!root || readGitLayout(root)?.kind !== "linked") return undefined;
    if (!fs.statSync(path.join(root, TOKENSAVE_DB), { throwIfNoEntry: false })?.isFile())
      return undefined;
    if (deps.servedDirectory && checkoutRootOf(deps.servedDirectory) === root) return undefined;
    try {
      (deps.refresh ?? refreshWorktreeIndex)(root);
    } catch {
      // A stale index still answers better than the main checkout's.
    }
    return { ...args, graph_root: root };
  } catch {
    return undefined;
  }
}

/**
 * The checkout a tokensave index command acts on: the one containing `cwd`
 * when it belongs to the Working Repository's clone, so a session moved into a
 * worktree indexes the worktree whatever `MATE_REPO_PATH` names; else `repoPath`.
 */
export function tokensaveCheckout(cwd: string, repoPath: string): string {
  const root = checkoutRootOf(cwd);
  return root && isSameClone(root, repoPath) ? root : repoPath;
}
