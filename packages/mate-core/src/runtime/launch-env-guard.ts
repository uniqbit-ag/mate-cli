import fs from "node:fs";
import path from "node:path";

import { MATE_ENV } from "./env-names";
import { checkoutRootOf, isLinkedWorktreeOf } from "./git-layout";

/**
 * A Mate launch environment can reach a process its launch did not start: a
 * Claude background session inherits the environment of the daemon, which
 * holds whichever launch started it. These checks keep such a stray
 * environment from describing another repository.
 */

const NAMES: readonly string[] = Object.values(MATE_ENV);

function inside(dir: string, root: string): boolean {
  const relative = path.relative(root, dir);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function real(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * True when the launch environment describes `cwd`: inside its Working
 * Repository, a linked worktree of it, or its Companion Repository. An
 * environment naming no Working Repository applies everywhere.
 */
export function launchEnvironmentApplies(
  env: Record<string, string | undefined>,
  cwd: string,
): boolean {
  const repository = env[MATE_ENV.repositoryPath];
  if (!repository) return true;
  const companion = env[MATE_ENV.companionPath];
  const dir = real(cwd);
  if (companion && inside(dir, real(companion))) return true;
  const repo = real(repository);
  if (inside(dir, repo)) return true;
  try {
    const checkout = checkoutRootOf(dir);
    return !!checkout && isLinkedWorktreeOf(real(checkout), repo);
  } catch {
    return false;
  }
}

/**
 * Removes empty `MATE_*` values (a background launch sets every name, empty
 * when unset), then the whole launch environment when it does not apply to
 * `cwd`. Mutates `env`.
 */
export function guardLaunchEnvironment(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): void {
  for (const name of NAMES) if (env[name] === "") delete env[name];
  if (launchEnvironmentApplies(env, cwd)) return;
  for (const name of NAMES) delete env[name];
}
