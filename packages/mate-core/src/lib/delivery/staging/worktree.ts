import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";
import { companionGit, nulPaths, type CompanionGit } from "../../../runtime/companion-git";
import type { ArtifactType } from "./artifact-type";
import { artifactTypes } from "./registry";

export interface TemporaryWorktreeDeps {
  /** Git for one directory; local commands only. */
  git?: (cwd: string) => CompanionGit;
  /** Parent of the temporary directory; the OS temp directory by default. */
  tmpRoot?: string;
  /** The types whose files Mate reads and writes there; every registered type by default. */
  types?: readonly ArtifactType[];
}

const localGit = (cwd: string): CompanionGit => companionGit(cwd, { prompt: "never" });

/**
 * Git options that run no hooks. A relative `core.hooksPath` resolves inside the worktree,
 * where a teammate's pending tree could supply the scripts.
 */
export const WITHOUT_HOOKS: readonly string[] = ["-c", `core.hooksPath=${os.devNull}`];

const SYMLINK_MODE = "120000";
const GITLINK_MODE = "160000";

/** The top-level directories `types` read and write, with Node's link-following fs. */
function contentRoots(types: readonly ArtifactType[]): string[] {
  return [
    ...new Set(
      types.flatMap((type) => [type.source.split("/")[0]!, type.archiveRoot.split("/")[0]!]),
    ),
  ];
}

/**
 * The paths at or below `roots` that `ref` holds as a symbolic link or submodule; null when
 * Git cannot list them. A teammate's ref could otherwise point a write outside the worktree.
 */
export async function linkedContentPaths(
  git: CompanionGit,
  ref: string,
  roots: readonly string[],
): Promise<string[] | null> {
  const listed = await git.run([
    "ls-tree",
    "-r",
    "-t",
    "-z",
    "--end-of-options",
    ref,
    "--",
    ...roots,
  ]);
  if (listed.status !== 0) return null;
  return nulPaths(listed.stdout)
    .filter((entry) => {
      const mode = entry.slice(0, entry.indexOf(" "));
      return mode === SYMLINK_MODE || mode === GITLINK_MODE;
    })
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
}

/**
 * Throws when `ref` in `git` holds a symbolic link or submodule below where `types` read and
 * write; `source` names the ref in the message.
 */
export async function assertNoLinkedContent(
  git: CompanionGit,
  ref: string,
  types: readonly ArtifactType[],
  source = ref,
): Promise<void> {
  const linked = await linkedContentPaths(git, ref, contentRoots(types));
  if (linked === null) throw new Error(`git ls-tree ${source} failed`);
  if (linked.length > 0) {
    throw new Error(
      `${source} holds a symbolic link or submodule at ${linked.join(", ")}; Mate does not submit or publish through it.`,
    );
  }
}

/**
 * Runs `use` in a detached worktree of `ref`, removed afterwards whether `use` succeeds or
 * throws. Stale registrations from a crashed earlier run are pruned first. The companion
 * checkout, its `HEAD` and index are never touched. Throws when `ref` holds a symbolic link
 * or submodule where Mate reads and writes.
 */
export async function withTemporaryWorktree<T>(
  companionPath: string,
  ref: string,
  use: (dir: string) => Promise<T>,
  deps: TemporaryWorktreeDeps = {},
): Promise<T> {
  const gitAt = deps.git ?? localGit;
  const git = gitAt(companionPath);
  await git.run(["worktree", "prune"]);
  const dir = await fs.mkdtemp(
    path.join(deps.tmpRoot ?? os.tmpdir(), `${FRAMEWORK_NAME}-staging-`),
  );
  const added = await git.run([
    ...WITHOUT_HOOKS,
    "worktree",
    "add",
    "--detach",
    "--end-of-options",
    dir,
    ref,
  ]);
  if (added.status !== 0) {
    await fs.rm(dir, { recursive: true, force: true });
    throw new Error(
      `git worktree add ${ref} failed: ${added.stderr.trim() || added.stdout.trim()}`,
    );
  }
  try {
    // The checkout's own `HEAD`: exactly the commit `use` works in.
    await assertNoLinkedContent(gitAt(dir), "HEAD", deps.types ?? artifactTypes(), ref);
    return await use(dir);
  } finally {
    await git.run(["worktree", "remove", "--force", dir]);
    await fs.rm(dir, { recursive: true, force: true });
    await git.run(["worktree", "prune"]);
  }
}
