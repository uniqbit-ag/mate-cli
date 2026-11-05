import fs from "node:fs";
import path from "node:path";

import { checkoutRootOf, isSameClone, readGitLayout } from "./git-layout";

/**
 * Routes tokensave tool calls to a linked worktree's own index. The MCP server
 * stays bound to the checkout the session started in; a per-call `graph_root`
 * is tokensave's own way to query another initialised project, read-only.
 */

/** The tokensave store's database, relative to a checkout root. */
export const TOKENSAVE_DB = path.join(".tokensave", "tokensave.db");

/**
 * `input` with `graph_root` set to the linked worktree containing `directory`,
 * when that worktree holds a tokensave index and `input` names no `graph_root`.
 * Otherwise, and on any error, `undefined`: the call passes unchanged.
 */
export function routeTokensaveInput(
  directory: string,
  input: unknown,
): Record<string, unknown> | undefined {
  try {
    // A tool with no arguments sends none; anything else must be an arguments object.
    const given = input === undefined ? {} : input;
    if (given === null || typeof given !== "object" || Array.isArray(given)) return undefined;
    const args = given as Record<string, unknown>;
    if (args.graph_root !== undefined && args.graph_root !== null) return undefined;
    const root = checkoutRootOf(directory);
    if (!root || readGitLayout(root)?.kind !== "linked") return undefined;
    if (!fs.statSync(path.join(root, TOKENSAVE_DB), { throwIfNoEntry: false })?.isFile())
      return undefined;
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
