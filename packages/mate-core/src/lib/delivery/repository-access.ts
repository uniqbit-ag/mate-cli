import { classifyBranch, workingRepoGit, type BranchProtection } from "./branches";
import { sameRepository } from "./record";
import type { DeliveryEnvironment } from "./environment";
import { mergeGit, type FetchResult, type MergeGit, type PullRef } from "./merge-git";
import type { LocalMergeAccess } from "./refresh";
import { parseRemote, type RemoteRepo } from "./remote";

/** What delivery needs to know about one repository, from its checkout linked on this machine. */
export interface RepositoryAccess {
  /** The Working Repository's from local Git; another's from its linked checkout, else `main`. */
  defaultBranch(): Promise<string>;
  /** Protected when it is the default branch or matches a configured pattern. */
  protection(branch: string): Promise<BranchProtection>;
  /** The repository's linked checkout for merge checks; absent or null without one. */
  local?(): Promise<LocalMergeAccess | null>;
}

/** Merge queries and the default branch of one checkout. */
export interface Checkout {
  git: MergeGit;
  defaultBranch(): Promise<string>;
}

export interface RepositoryAccessDeps {
  openCheckout?: (path: string) => Checkout;
}

function defaultOpenCheckout(path: string): Checkout {
  return { git: mergeGit(path), defaultBranch: () => workingRepoGit(path).defaultBranch() };
}

/**
 * Access per repository, only through a checkout the environment links on this machine (the
 * Working Repository, a Repository Link, or an Umbrella Repository child). A repository named
 * only by a record is never inspected: it gets `main` as default branch and no local access.
 */
export function repositoryAccessFor(
  environment: DeliveryEnvironment,
  deps: RepositoryAccessDeps = {},
): (repository: string) => RepositoryAccess {
  const accesses = new Map<string, RepositoryAccess>();

  return (repository) => {
    const key = repository.toLowerCase();
    let access = accesses.get(key);
    if (!access) {
      const slug = environment.workingRepo?.slug;
      const working = slug && sameRepository(slug, repository) ? environment.workingRepo : null;
      let localAccess: Promise<LocalMergeAccess | null> | undefined;
      const local = (): Promise<LocalMergeAccess | null> =>
        (localAccess ??= openLocal(environment, repository, deps.openCheckout));
      let otherDefault: Promise<string> | undefined;
      const defaultBranch = working
        ? () => working.git.defaultBranch()
        : () => (otherDefault ??= local().then((checkout) => checkout?.defaultBranch ?? "main"));
      access = {
        defaultBranch,
        protection: async (branch) =>
          classifyBranch(branch, {
            defaultBranch: await defaultBranch(),
            patterns: environment.protectedPatterns,
          }),
        local,
      };
      accesses.set(key, access);
    }
    return access;
  };
}

/** The linked checkout's merge access; each branch is fetched and the pull refs listed once. */
async function openLocal(
  environment: DeliveryEnvironment,
  repository: string,
  open: ((path: string) => Checkout) | undefined,
): Promise<LocalMergeAccess | null> {
  const path = await environment.checkoutOf?.(repository);
  if (!path) return null;
  const checkout = (open ?? defaultOpenCheckout)(path);
  if (!(await checkout.git.isRepository())) return null;
  const defaultBranch = await checkout.defaultBranch();
  const fetched = new Map<string, Promise<FetchResult>>();
  let remote: Promise<RemoteRepo | null> | undefined;
  let pullRefs: Promise<PullRef[] | null> | undefined;
  return {
    git: checkout.git,
    defaultBranch,
    fetch(branch) {
      let result = fetched.get(branch);
      if (!result) {
        result = checkout.git.fetch(defaultBranch, branch);
        fetched.set(branch, result);
      }
      return result;
    },
    remote: () =>
      (remote ??= checkout.git.originUrl().then((url) => (url ? parseRemote(url) : null))),
    pullRefs: () => (pullRefs ??= checkout.git.pullRefs()),
  };
}
