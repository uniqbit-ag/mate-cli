import { randomUUID } from "node:crypto";

import { TRANSACTION_TRAILER } from "../../artifact-trailer";
import {
  describeGitFailure,
  LITERAL_PATHSPECS,
  nulPaths,
  type CompanionGit,
  type GitResult,
  type NetworkGitResult,
} from "../../../runtime/companion-git";
import {
  scanPublication,
  type PublicationSecretScan,
} from "../../../runtime/publication-secret-scan";
import type { SecretFinding } from "../../../runtime/secret-scan";
import type { ArtifactType } from "./artifact-type";
import {
  fetchPendingBranches,
  fetchStaging,
  isPushNotPermitted,
  isRejectedPush,
  pendingBase,
  pendingPlace,
  pendingRef,
  pushPending,
  stagingRemote,
  transactionsAt,
  type StagingRemote,
} from "./refs";
import { defaultArtifactType } from "./registry";
import { withTemporaryWorktree, WITHOUT_HOOKS, type TemporaryWorktreeDeps } from "./worktree";

/** Pushes per commit; a rejected push rebuilds on the newly fetched pending branch. */
const PUSH_ATTEMPTS = 3;

export interface PendingCommitInput<T> {
  companionPath: string;
  subject: string;
  /**
   * Edits the pending tip checked out at `dir` and returns the paths it touched, which are then
   * staged; `{ stop }` ends without a commit. Runs again on a rebuilt attempt. A throw passes
   * through.
   */
  edit: (dir: string, remote: StagingRemote) => Promise<string[] | { stop: T }>;
  /** The remote as the caller already resolved it; looked up from the upstream when absent. */
  remote?: StagingRemote;
  /** Value of the commit's `Mate-Transaction` trailer; a new one when absent. */
  transaction?: string;
  /** Asked after the secret scan, right before the commit; false ends without one. */
  beforeCommit?: () => boolean;
}

export interface PendingCommitDeps {
  /** Git for one directory, network included. */
  git: (cwd: string) => CompanionGit;
  /** Scans `paths` under `root` with the companion's policy; the publication scan by default. */
  scan?: (root: string, paths: string[], policyPath: string) => Promise<PublicationSecretScan>;
  /** The changes' artifact type; OpenSpec by default. */
  artifactType?: ArtifactType;
  newTransaction?: () => string;
  tmpRoot?: string;
}

/** Why no commit reached the pending branch; `detail` says so as a default text. */
export type PendingCommitFailure = { status: "failed"; detail: string } & (
  | { reason: "no-remote"; remote: null }
  | { reason: "fetch-failed"; remote: StagingRemote }
  | { reason: "secret"; remote: StagingRemote; secretFindings: SecretFinding[] }
  | {
      /**
       * `conflict`: rejected through every attempt, the pending branch kept moving.
       * `not-permitted`: the remote refused this user's push to the pending branch.
       */
      reason: "commit-failed" | "conflict" | "not-permitted" | "push-failed";
      remote: StagingRemote;
      /** The failed Git command. */
      git: GitResult;
    }
);

export type PendingCommitResult<T> =
  | { status: "pushed"; commit: string; remote: StagingRemote }
  /** The edit staged nothing; no commit was made. */
  | { status: "unchanged"; remote: StagingRemote }
  /** Ended by the edit's `{ stop }`, or by `beforeCommit` with no value. */
  | { status: "stopped"; value: T | undefined; remote: StagingRemote }
  | PendingCommitFailure;

type Stop<T> =
  | { kind: "unchanged" }
  | { kind: "stopped"; value: T | undefined }
  | { kind: "secret"; findings: SecretFinding[] };

/**
 * Makes one commit on the pending branch: `edit` runs in a temporary worktree of the fetched
 * tip, the paths it touched are staged, and what is staged, removals left out, passes the
 * secret scan before it is committed and pushed without force. A rejected push is rebuilt on the
 * new tip; a failed or cut-off push counts as pushed when its transaction trailer reached the
 * remote. The checkout is never touched.
 */
export async function commitToPending<T = never>(
  input: PendingCommitInput<T>,
  deps: PendingCommitDeps,
): Promise<PendingCommitResult<T>> {
  const gitFor = deps.git;
  const known = input.remote;
  const configured = known ?? (await stagingRemote(gitFor(input.companionPath)));
  if (!configured) {
    return {
      status: "failed",
      reason: "no-remote",
      detail: "the companion has no upstream",
      remote: null,
    };
  }
  const outcome = await editPending<Stop<T>>({
    companionPath: input.companionPath,
    gitFor,
    fetch: async (git) => {
      if (!known) return fetchPendingBranches(git, configured);
      const fetched = await fetchStaging(git, known);
      return fetched.status === 0 ? known : { error: describeGitFailure(fetched) };
    },
    subject: input.subject,
    transaction: input.transaction ?? (deps.newTransaction ?? randomUUID)(),
    attempts: PUSH_ATTEMPTS,
    edit: async (dir, remote) => {
      const edited = await input.edit(dir, remote);
      if ("stop" in edited) return { stop: { kind: "stopped", value: edited.stop } };
      const work = gitFor(dir);
      // Forced: the edit already chose the files; the base ref's ignore rules must not drop one.
      if (edited.length > 0) {
        await work.run([...LITERAL_PATHSPECS, "add", "-f", "-A", "--", ...edited]);
      }
      // NUL-separated, so a non-ASCII path is not quoted out of the secret scan.
      const staged = ["diff", "--cached", "--name-only", "-z", "--no-renames"];
      if (nulPaths((await work.run(staged)).stdout).length === 0) {
        return { stop: { kind: "unchanged" } };
      }
      const kept = nulPaths((await work.run([...staged, "--diff-filter=d"])).stdout);
      if (kept.length > 0) {
        const scan = await (deps.scan ?? scanPublication)(dir, kept, input.companionPath);
        if (!scan.skipped && scan.findings.length > 0) {
          return { stop: { kind: "secret", findings: scan.findings } };
        }
      }
      if (input.beforeCommit?.() === false) {
        return { stop: { kind: "stopped", value: undefined } };
      }
      return null;
    },
    worktree: {
      git: gitFor,
      types: [deps.artifactType ?? defaultArtifactType()],
      ...(deps.tmpRoot ? { tmpRoot: deps.tmpRoot } : {}),
    },
  });
  switch (outcome.kind) {
    case "pushed":
      return { status: "pushed", commit: outcome.commit, remote: outcome.remote };
    case "stopped": {
      const { value: stop, remote } = outcome;
      if (stop.kind === "unchanged") return { status: "unchanged", remote };
      if (stop.kind === "stopped") return { status: "stopped", value: stop.value, remote };
      return {
        status: "failed",
        reason: "secret",
        detail: "the commit contains secrets",
        remote,
        secretFindings: stop.findings,
      };
    }
    case "fetch-failed":
      return {
        status: "failed",
        reason: "fetch-failed",
        detail: outcome.error,
        remote: configured,
      };
    case "commit-failed":
      return {
        status: "failed",
        reason: "commit-failed",
        detail: describeGitFailure(outcome.result),
        remote: outcome.remote,
        git: outcome.result,
      };
    case "conflict":
      return {
        status: "failed",
        reason: "conflict",
        detail: `${pendingPlace(outcome.remote)} kept moving`,
        remote: outcome.remote,
        git: outcome.push,
      };
    case "not-permitted":
    case "push-failed":
      return {
        status: "failed",
        reason: outcome.kind,
        detail: `pushing ${pendingPlace(outcome.remote)} failed. ${describeGitFailure(outcome.push)}`,
        remote: outcome.remote,
        git: outcome.push,
      };
  }
}

interface PendingEdit<T> {
  companionPath: string;
  gitFor: (cwd: string) => CompanionGit;
  /** Fetches the pending branches: the remote as fetched, or why the fetch failed. */
  fetch: (git: CompanionGit) => Promise<StagingRemote | { error: string }>;
  subject: string;
  /** Value of the commit's `Mate-Transaction` trailer; settles a cut-off push. */
  transaction: string;
  /** Pushes in all; a rejected push rebuilds on the newly fetched tip. */
  attempts: number;
  /**
   * Edits and stages the pending tip checked out at `dir`: `{ stop }` ends without a commit,
   * null commits what is staged.
   */
  edit: (dir: string, remote: StagingRemote) => Promise<{ stop: T } | null>;
  worktree: TemporaryWorktreeDeps;
}

type PendingEditOutcome<T> =
  | { kind: "stopped"; value: T; remote: StagingRemote }
  | { kind: "pushed"; commit: string; remote: StagingRemote }
  | { kind: "fetch-failed"; error: string }
  | { kind: "commit-failed"; result: GitResult; remote: StagingRemote }
  | { kind: "conflict"; push: NetworkGitResult; remote: StagingRemote }
  | { kind: "not-permitted"; push: NetworkGitResult; remote: StagingRemote }
  | { kind: "push-failed"; push: NetworkGitResult; remote: StagingRemote };

type Built<T> =
  | { kind: "stopped"; value: T }
  | { kind: "commit-failed"; result: GitResult }
  | { kind: "pushed"; commit: string; push: NetworkGitResult };

/** The commit, push and rebuild loop of {@link commitToPending}; throws pass through. */
async function editPending<T>(e: PendingEdit<T>): Promise<PendingEditOutcome<T>> {
  const git = e.gitFor(e.companionPath);
  for (let attempt = 1; ; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each attempt starts from a fresh fetch
    const remote = await e.fetch(git);
    if ("error" in remote) return { kind: "fetch-failed", error: remote.error };
    // oxlint-disable-next-line no-await-in-loop -- same attempt
    const base = await pendingBase(git, remote);
    // oxlint-disable-next-line no-await-in-loop -- same attempt
    const built = await withTemporaryWorktree(
      e.companionPath,
      base,
      async (dir): Promise<Built<T>> => {
        const stopped = await e.edit(dir, remote);
        if (stopped) return { kind: "stopped", value: stopped.stop };
        const work = e.gitFor(dir);
        const committed = await work.run([
          ...WITHOUT_HOOKS,
          "commit",
          "-q",
          "-m",
          e.subject,
          "-m",
          `${TRANSACTION_TRAILER}: ${e.transaction}`,
        ]);
        if (committed.status !== 0) return { kind: "commit-failed", result: committed };
        const commit = (await work.run(["rev-parse", "HEAD"])).stdout.trim();
        return { kind: "pushed", commit, push: await pushPending(work, remote) };
      },
      e.worktree,
    );
    if (built.kind !== "pushed") return { ...built, remote };
    const { commit, push } = built;
    if (push.status === 0) return { kind: "pushed", commit, remote };
    if (isRejectedPush(push)) {
      if (attempt < e.attempts) continue;
      return { kind: "conflict", push, remote };
    }
    if (isPushNotPermitted(push)) return { kind: "not-permitted", push, remote };
    // A failed or cut-off push may still have been accepted; the trailer settles it.
    // oxlint-disable-next-line no-await-in-loop -- settles this attempt
    if ((await fetchStaging(git, remote)).status === 0) {
      // oxlint-disable-next-line no-await-in-loop -- settles this attempt
      if ((await transactionsAt(git, pendingRef(remote))).includes(e.transaction)) {
        return { kind: "pushed", commit, remote };
      }
    }
    return { kind: "push-failed", push, remote };
  }
}
