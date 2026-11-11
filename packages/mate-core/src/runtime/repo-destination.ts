import fs from "node:fs";
import path from "node:path";

import { FRAMEWORK_NAME } from "./framework";
import { isWithin, physicalPath } from "./physical-path";

/**
 * The one containment check for what Mate places inside a Working Repository:
 * a destination must resolve inside the repository's physical path, and no
 * folder below the root on the way to it may be a symbolic link. A symlinked
 * repository root stays allowed, because the root is resolved first.
 */

export type RepoDestination =
  | {
      kind: "inside";
      /** Absolute, under `root`. */
      path: string;
      /** The repository's physical path; the bound for pruning. */
      root: string;
    }
  | { kind: "refused"; warning: string };

/** `key` is repo-relative with POSIX separators. The leaf may be anything. */
export function repoDestination(repoPath: string, key: string): RepoDestination {
  return resolve(repoPath, key, false);
}

/** {@link repoDestination}, and an existing leaf must be a real directory too. */
export function repoDirectory(repoPath: string, key: string): RepoDestination {
  return resolve(repoPath, key, true);
}

/** The outcome warning for a refused destination. */
export function refusedDestinationWarning(key: string, reason: string): string {
  return `${key} was skipped: ${reason}. ${FRAMEWORK_NAME} does not follow it out of the Working Repository.`;
}

function resolve(repoPath: string, key: string, directory: boolean): RepoDestination {
  const root = physicalPath(path.resolve(repoPath));
  const target = path.join(root, ...key.split("/"));
  if (target === root || !isWithin(target, root)) {
    return refused(key, `${key} is not inside the Working Repository`);
  }
  const segments = path.relative(root, target).split(path.sep);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = lstatOrNull(current);
    if (stat === null) break;
    const leaf = index === segments.length - 1;
    if ((leaf && !directory) || stat.isDirectory()) continue;
    const named = segments.slice(0, index + 1).join("/");
    return refused(
      key,
      stat.isSymbolicLink() ? `${named} is a symbolic link` : `${named} is not a directory`,
    );
  }
  return { kind: "inside", path: target, root };
}

function refused(key: string, reason: string): RepoDestination {
  return { kind: "refused", warning: refusedDestinationWarning(key, reason) };
}

function lstatOrNull(candidate: string): fs.Stats | null {
  try {
    return fs.lstatSync(candidate);
  } catch {
    return null;
  }
}
