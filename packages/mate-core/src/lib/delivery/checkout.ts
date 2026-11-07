import {
  localGitEnv,
  mergeGit,
  spawnProcess,
  type MergeGit,
  type ProcessResult,
} from "./merge-git";
import { localMergeEvidence } from "./refresh";

/** True when the ref resolves in the checkout. */
export type HasRef = (ref: string) => Promise<boolean>;

/** Full names of the refs under the given prefixes, e.g. `refs/heads/workset/`. */
export type ListRefs = (prefixes: string[]) => Promise<string[]>;

/**
 * A local merge check, without fetch or forge: a merge commit settles `merged`, commits
 * matched on the default branch read as `squashed`. A head on the default branch's own line
 * is `open`: it may be a fast-forward, but then its commits are already there and continuing
 * on it is safe.
 */
export type MergeProbeResult = "merged" | "squashed" | "open";

/** The local Git a Delivery Branch resolves in: refs, the default branch, and merge checks. */
export interface DeliveryCheckout {
  hasRef: HasRef;
  listRefs: ListRefs;
  /** `origin/HEAD`, then an existing `origin/main` or `origin/master`, then `init.defaultBranch`, then `main`. */
  defaultBranch(): Promise<string>;
  /** Null when the checkout cannot check merges; the branch then counts as never checked. */
  mergeProbe(branch: string, recordedHead: string | undefined): Promise<MergeProbeResult | null>;
}

/**
 * Runs `git` in the checkout. `env` is the environment local queries need; a runner with
 * its own Git policy (another user, extra `-c` settings) may keep its own instead.
 */
export type CheckoutRunner = (
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; input?: string; timeoutMs?: number },
) => Promise<ProcessResult>;

/** A {@link ListRefs} over a Git runner that answers stdout, or null on failure. */
function listRefsWith(git: (args: string[]) => Promise<string | null>): ListRefs {
  return async (prefixes) => {
    const stdout = await git(["for-each-ref", "--format=%(refname)", ...prefixes]);
    return stdout ? stdout.split("\n").filter(Boolean) : [];
  };
}

/** The default branch over a Git runner that answers trimmed stdout, or null on failure. */
async function defaultBranchWith(
  run: (...args: string[]) => Promise<string | null>,
): Promise<string> {
  const remoteHead = await run("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
  if (remoteHead) return remoteHead.replace(/^origin\//, "");
  for (const candidate of ["main", "master"]) {
    // oxlint-disable-next-line no-await-in-loop -- the steps are a decision chain
    if (await run("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${candidate}`)) {
      return candidate;
    }
  }
  return (await run("config", "--get", "init.defaultBranch")) || "main";
}

/** The merge check over local merge queries; see {@link MergeProbeResult}. */
export async function probeMerge(
  git: MergeGit,
  defaultBranch: string,
  branch: string,
  recordedHead: string | undefined,
): Promise<MergeProbeResult> {
  const evidence = await localMergeEvidence(git, defaultBranch, branch, recordedHead);
  if (evidence.merged) return "merged";
  const style = evidence.suggestion?.style;
  return style === "squash" || style === "rebase" ? "squashed" : "open";
}

/**
 * The checkout at `path`, every query through one runner, so a caller's Git policy reaches
 * ref lookups and merge checks alike. Without `run`, `git` is spawned in `path`.
 */
export function deliveryCheckout(path: string, run?: CheckoutRunner): DeliveryCheckout {
  const git: CheckoutRunner =
    run ?? ((args, options) => spawnProcess("git", args, { cwd: path, ...options }));
  const env = localGitEnv();
  const stdout = async (...args: string[]): Promise<string | null> => {
    const result = await git(args, { env });
    return result.code === 0 ? result.stdout.trim() || null : null;
  };
  let defaultBranch: Promise<string> | undefined;
  const merges = mergeGit(path, { spawn: (_command, args, options) => git(args, options) });
  const checkout: DeliveryCheckout = {
    hasRef: async (ref) =>
      (await git(["rev-parse", "--verify", "--quiet", ref], { env })).code === 0,
    listRefs: listRefsWith((args) => stdout(...args)),
    defaultBranch: () => (defaultBranch ??= defaultBranchWith(stdout)),
    mergeProbe: async (branch, recordedHead) =>
      probeMerge(merges, await checkout.defaultBranch(), branch, recordedHead),
  };
  return checkout;
}
