import fs from "node:fs/promises";
import path from "node:path";

import {
  describeGitFailure,
  isTransientRemoteFailure,
  nulPaths,
  outputLines,
  type CompanionGit,
  type NetworkGitResult,
} from "../../../runtime/companion-git";
import { TRANSACTION_TRAILER } from "../../artifact-trailer";
import {
  trailerRecordsAt as readTrailerRecords,
  type TrailerRecord,
} from "../../../runtime/artifact-trailers";
import { INBOX_BRANCH } from "../../../runtime/pending-records";
import type { ArtifactType } from "./artifact-type";
import { WITHOUT_HOOKS } from "./worktree";

/** The companion's remote and default branch, as submit and publication address them. */
export interface StagingRemote {
  remote: string;
  defaultBranch: string;
  /** Where submitted changes wait: always the inbox {@link INBOX_BRANCH}. */
  pendingBranch: string;
}

/** Where submitted changes wait, for messages. */
export function pendingPlace(remote: StagingRemote): string {
  return `the inbox ${remote.pendingBranch}`;
}

/** Remote-tracking ref of `branch` on the companion remote. */
function trackingRef(remote: Pick<StagingRemote, "remote">, branch: string): string {
  return `refs/remotes/${remote.remote}/${branch}`;
}

export function defaultRef(remote: StagingRemote): string {
  return trackingRef(remote, remote.defaultBranch);
}

/** The companion's upstream as a staging remote; null when it has none. */
export async function stagingRemote(git: CompanionGit): Promise<StagingRemote | null> {
  const target = await git.upstreamTarget();
  if (!target) return null;
  const defaultBranch = (await remoteHead(git, target.remote)) ?? target.branch;
  return { remote: target.remote, defaultBranch, pendingBranch: INBOX_BRANCH };
}

/**
 * The branch `remote/HEAD` names, the remote's default branch as cloned; null when unset. A
 * companion checked out on another branch still submits and publishes there.
 */
async function remoteHead(git: CompanionGit, remote: string): Promise<string | null> {
  const head = await git.run([
    "symbolic-ref",
    "--quiet",
    "--short",
    "--end-of-options",
    `refs/remotes/${remote}/HEAD`,
  ]);
  const name = head.stdout.trim();
  return head.status === 0 && name.startsWith(`${remote}/`) ? name.slice(remote.length + 1) : null;
}

export { INBOX_BRANCH };

/** Remote-tracking ref of the pending branch. */
export function pendingRef(remote: StagingRemote): string {
  return trackingRef(remote, remote.pendingBranch);
}

/**
 * Fetches the default branch and the inbox into their remote-tracking refs, in one call; nothing
 * else. The inbox is named by a pattern, which matches nothing on a remote without one instead
 * of failing, and a deleted inbox is pruned.
 */
export function fetchStaging(git: CompanionGit, remote: StagingRemote): Promise<NetworkGitResult> {
  return git.fetch([
    "--prune",
    remote.remote,
    `+refs/heads/${remote.defaultBranch}:${defaultRef(remote)}`,
    `+refs/heads/${remote.pendingBranch}*:${pendingRef(remote)}*`,
  ]);
}

/** {@link fetchStaging}, a failure as a message. */
export async function fetchPendingBranches(
  git: CompanionGit,
  remote: StagingRemote,
): Promise<StagingRemote | { error: string; transient: boolean }> {
  const fetched = await fetchStaging(git, remote);
  if (fetched.status !== 0) {
    return {
      error: `fetching the companion remote failed. ${describeGitFailure(fetched)}`,
      transient: isTransientRemoteFailure(fetched),
    };
  }
  return remote;
}

/**
 * The inbox's tip as last fetched, else (an inbox not started yet) a new empty root commit to
 * start it on: the first push creates the branch, and a concurrent first push is rejected and
 * rebuilt on the winner.
 */
export async function pendingBase(git: CompanionGit, remote: StagingRemote): Promise<string> {
  const tip = await git.run(["rev-parse", "--verify", "-q", `${pendingRef(remote)}^{commit}`]);
  if (tip.status === 0 && tip.stdout.trim()) return tip.stdout.trim();
  const tree = await git.run(["hash-object", "-w", "-t", "tree", "/dev/null"]);
  const root =
    tree.status === 0
      ? await git.run(["commit-tree", tree.stdout.trim(), "-m", "chore: start the pending inbox"])
      : tree;
  if (root.status !== 0) throw new Error(`starting the inbox failed: ${root.stderr.trim()}`);
  return root.stdout.trim();
}

/**
 * Pushes `HEAD` to the pending branch, without force. No hooks run for the inbox, on commit or
 * push: they would come from teammates' pushes. Mate's own secret scan guards it.
 */
export function pushPending(git: CompanionGit, remote: StagingRemote): Promise<NetworkGitResult> {
  return git.push([remote.remote, `HEAD:refs/heads/${remote.pendingBranch}`], WITHOUT_HOOKS);
}

/**
 * A push the remote refused because the branch moved since the fetch, or because a concurrent
 * push created it first.
 */
export function isRejectedPush(result: NetworkGitResult): boolean {
  return /\[rejected\]|non-fast-forward|fetch first|stale info|reference already exists/i.test(
    result.stderr,
  );
}

/**
 * A push the remote refused for this user: a protected branch, a push rule or no write access,
 * as GitHub, GitLab, Bitbucket and Azure DevOps word it. Someone with push rights publishes
 * instead. A rejection for content (secret push protection, a server hook) or a ref lock is not
 * one: nobody can push that.
 */
export function isPushNotPermitted(result: NetworkGitResult): boolean {
  if (/cannot contain secrets|secret scanning|push protection/i.test(result.stderr)) return false;
  return /protected branch|permission to .* denied|not allowed to push|returned error: 403|GH006|GH013|changes must be made through a pull request|only be modified through pull requests|TF402455|pushes to this branch are not permitted/i.test(
    result.stderr,
  );
}

/** `map` over `items`, at most `limit` at a time, results in input order. */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      // oxlint-disable-next-line no-await-in-loop -- the bound is the point
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export type { TrailerRecord };

/**
 * The records of `type` published on `ref`, newest first, from the `Mate-Artifact` trailers of
 * its history: how a type that keeps no archive knows a change is published.
 */
export function trailerRecordsAt(
  git: CompanionGit,
  ref: string,
  type: Pick<ArtifactType, "name" | "isRecordId">,
): Promise<TrailerRecord[]> {
  return readTrailerRecords(git, ref, type.name, type.isRecordId);
}

/**
 * Records present at `ref`, as {@link anchorsAt}; for a type without an archive with the inbox
 * commit each was published from.
 */
export async function recordsAt(
  git: CompanionGit,
  ref: string,
  type: ArtifactType,
): Promise<TrailerRecord[]> {
  if (type.archiveRoot === undefined) return trailerRecordsAt(git, ref, type);
  return (await anchorsAt(git, ref, type)).map((id) => ({ id, inbox: null }));
}

/**
 * Records present at `ref`: its archive anchors, or for a type without an archive the records
 * its history published. Empty when the ref or the archive directory is missing.
 */
export async function anchorsAt(
  git: CompanionGit,
  ref: string,
  type: ArtifactType,
): Promise<string[]> {
  if (type.archiveRoot === undefined) {
    return (await trailerRecordsAt(git, ref, type)).map((record) => record.id);
  }
  // A path filter, unlike `<ref>:<path>`, lists a missing directory as empty, not as a failure.
  const listed = await git.run([
    "ls-tree",
    "-d",
    "-z",
    "--name-only",
    "--end-of-options",
    ref,
    "--",
    `${type.archiveRoot}/`,
  ]);
  if (listed.status !== 0) return [];
  return nulPaths(listed.stdout)
    .map((listedPath) => path.posix.basename(listedPath))
    .filter((name) => type.isRecordId(name));
}

/** When the companion last fetched, from `FETCH_HEAD`; null when it never did. */
export async function lastFetchedAt(git: CompanionGit): Promise<string | null> {
  const located = await git.run([
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "FETCH_HEAD",
  ]);
  if (located.status !== 0) return null;
  try {
    const stat = await fs.stat(located.stdout.trim());
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

/** Values of the `Mate-Transaction` trailer on the last `depth` commits of `ref`. */
export async function transactionsAt(
  git: CompanionGit,
  ref: string,
  depth = 50,
): Promise<string[]> {
  const log = await git.run([
    "log",
    `-n${depth}`,
    `--format=%(trailers:key=${TRANSACTION_TRAILER},valueonly,separator=%x0a)`,
    "--end-of-options",
    ref,
  ]);
  return log.status === 0 ? outputLines(log.stdout) : [];
}
