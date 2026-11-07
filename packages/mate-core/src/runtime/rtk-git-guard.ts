import { spawnSync } from "node:child_process";

import { resolveCompanionRuntime } from "./env";
import { isCapabilityEnabled, readCompanionPolicy } from "./policy";

/**
 * Claude Code's worktree guard refuses git behind a launcher, so `rtk git` fails
 * in a session moved into a linked worktree. `RTK_DISABLED=1 git` passes both:
 * RTK leaves that segment alone and the guard reads plain git.
 */

/** RTK's rewrite of `command`, or null when it rewrites nothing or cannot answer. */
export type RewriteRunner = (command: string) => string | null;

const REWRITE_TIMEOUT_MS = 1_000;

/**
 * `rtk rewrite`, the single source of truth RTK's own hooks use. It prints the
 * rewrite on stdout and exits 3 (0 when already `rtk`), or prints nothing and
 * exits 1; the exit code is ignored. A missing binary or a timeout answers null.
 */
function rtkRewrite(command: string): string | null {
  const result = spawnSync("rtk", ["rewrite", command], {
    encoding: "utf8",
    timeout: REWRITE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.signal) return null;
  return result.stdout.trim() || null;
}

const RTK_GIT = /(^|[\s;&|(])rtk git(?=\s|$)/g;

/**
 * The command to run instead when RTK would run `command` as `rtk git`: RTK's
 * rewrite with each `rtk git` as `RTK_DISABLED=1 git`, every other segment kept.
 * Null otherwise, including when the runner fails.
 */
export function runnableGitCommand(
  command: string,
  rewrite: RewriteRunner = rtkRewrite,
): string | null {
  let rewritten: string | null;
  try {
    rewritten = rewrite(command);
  } catch {
    return null;
  }
  if (!rewritten) return null;
  const runnable = rewritten.replace(RTK_GIT, "$1RTK_DISABLED=1 git");
  return runnable === rewritten ? null : runnable;
}

/** True when the policy of the companion at `companionPath` selects RTK. */
export function companionPolicySelectsRtk(companionPath: string): boolean {
  return isCapabilityEnabled(readCompanionPolicy(companionPath), "rtk");
}

/** True when the companion of the session at `cwd` selects RTK; the launch environment wins. */
export function companionSelectsRtk(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const { companionPath } = resolveCompanionRuntime(env, cwd).context;
  return Boolean(companionPath) && companionPolicySelectsRtk(companionPath);
}
