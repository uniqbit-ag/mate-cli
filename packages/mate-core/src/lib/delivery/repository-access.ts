import { classifyBranch, type BranchProtection } from "./branches";
import { sameRepository } from "./record";
import type { DeliveryEnvironment } from "./environment";
import { forgeFor, forgeRepoOf, type ForgeDeps, type ForgeRepo } from "./forge";
import type { ForgeAccess } from "./refresh";
import { resolveForgeToken, type ForgeToken } from "./token";

/** What delivery needs to know about one repository, from local Git or the forge. */
export interface RepositoryAccess {
  /** The Working Repository's from local Git; another's from the forge, else `main`. */
  defaultBranch(): Promise<string>;
  /** Protected when it is the default branch or matches a configured pattern. */
  protection(branch: string): Promise<BranchProtection>;
  forge(): Promise<ForgeAccess>;
}

export interface RepositoryAccessDeps {
  resolveToken?: () => Promise<ForgeToken | null>;
  forge?: ForgeDeps;
}

/**
 * Access per repository, the Working Repository's through local Git first. The forge token
 * is resolved at most once, and only when a lookup needs it.
 */
export function repositoryAccessFor(
  environment: DeliveryEnvironment,
  deps: RepositoryAccessDeps = {},
): (repository: string) => RepositoryAccess {
  let token: Promise<ForgeToken | null> | undefined;
  const resolveToken = (): Promise<ForgeToken | null> =>
    (token ??= (deps.resolveToken ?? (() => resolveForgeToken()))());
  const accesses = new Map<string, RepositoryAccess>();

  return (repository) => {
    const key = repository.toLowerCase();
    let access = accesses.get(key);
    if (!access) {
      const slug = environment.workingRepo?.slug;
      const working = slug && sameRepository(slug, repository) ? environment.workingRepo : null;
      const forgeRepo = async (): Promise<ForgeRepo | null> =>
        working?.forgeRepo ?? otherForgeRepo(environment, repository);
      let forgeAccess: Promise<ForgeAccess> | undefined;
      const forge = (): Promise<ForgeAccess> =>
        (forgeAccess ??= connect(forgeRepo, resolveToken, deps.forge));
      const defaultBranch = working ? () => working.git.defaultBranch() : forgeDefaultBranch(forge);
      access = {
        defaultBranch,
        protection: async (branch) =>
          classifyBranch(branch, {
            defaultBranch: await defaultBranch(),
            patterns: environment.protectedPatterns,
          }),
        forge,
      };
      accesses.set(key, access);
    }
    return access;
  };
}

/**
 * Another repository's host comes from a linked checkout's remote, else the Working
 * Repository's; never assumed. Null when no host is known.
 */
async function otherForgeRepo(
  environment: DeliveryEnvironment,
  repository: string,
): Promise<ForgeRepo | null> {
  const host = (await environment.hostOf?.(repository)) ?? environment.workingRepo?.forgeRepo?.host;
  return host ? forgeRepoOf(host, repository) : null;
}

async function connect(
  forgeRepo: () => Promise<ForgeRepo | null>,
  resolveToken: () => Promise<ForgeToken | null>,
  deps: ForgeDeps | undefined,
): Promise<ForgeAccess> {
  const repo = await forgeRepo();
  if (!repo) return { unavailable: "unsupported-host" };
  const resolved = await resolveToken();
  if (!resolved) return { unavailable: "no-token" };
  const adapter = forgeFor(repo, resolved.token, deps);
  return adapter ? { adapter, repo } : { unavailable: "unsupported-host" };
}

/** Another repository's default branch from the forge, asked once; `main` when it cannot answer. */
function forgeDefaultBranch(forge: () => Promise<ForgeAccess>): () => Promise<string> {
  let known: Promise<string> | undefined;
  return () =>
    (known ??= (async () => {
      const access = await forge();
      if (!("adapter" in access)) return "main";
      const answer = await access.adapter.defaultBranch(access.repo);
      return answer.ok ? answer.value : "main";
    })());
}
