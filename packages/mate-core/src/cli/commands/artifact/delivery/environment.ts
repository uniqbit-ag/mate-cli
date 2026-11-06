import {
  workingRepoGit,
  configuredBranchTemplate,
  configuredProtectedPatterns,
  configuredTicketFormat,
  type WorkingRepoGit,
} from "../../../../lib/delivery/branches";
import type { DeliveryEnvironment, WorkingRepoInfo } from "../../../../lib/delivery/environment";
import { parseRemote, repositoryPath, type ForgeRepo } from "../../../../lib/delivery/forge";
import { sameRepository } from "../../../../lib/delivery/record";
import { hasOpenspecCapability } from "../../../../lib/orchestrator/capabilities";
import {
  resolveForCapability,
  type LaunchContext,
} from "../../../../lib/orchestrator/framework-context";
import type { CapabilityConfig, LinkedRepository } from "../../../../lib/orchestrator/types";
import {
  linkedCheckoutsOf,
  umbrellaChildrenOf,
  type EntryCheckout,
  type OriginReader,
} from "../../../../lib/orchestrator/umbrella-checkouts";
import { WorkingRepoRequiredError } from "../../../../lib/orchestrator/types";
import { ensureUnambiguousCompanion } from "../../shared/companion-selection";

export interface DeliveryEnvironmentDeps {
  ensureUnambiguousCompanion?: (cwd: string) => Promise<boolean>;
  resolveContext?: (cwd: string) => Promise<LaunchContext>;
  loadCapabilities?: (context: LaunchContext) => Promise<CapabilityConfig[]>;
  workingRepoGit?: (repoPath: string) => WorkingRepoGit;
  loadLinkedRepositories?: (context: LaunchContext) => Promise<LinkedRepository[]>;
  /** Reads an Umbrella Repository child's `origin`; raw config by default, as worktree planning reads it. */
  readChildOrigin?: OriginReader;
  /** True when the companion's Git mode is `auto`. */
  loadGitAutoMode?: (context: LaunchContext) => Promise<boolean>;
}

async function defaultLoadLinkedRepositories(context: LaunchContext): Promise<LinkedRepository[]> {
  return (await context.workingRepoStore.load()).repos;
}

/** A linked repository's checkout with its parsed `origin` remote. */
interface LinkedCheckout {
  remote: ForgeRepo;
  path: string;
}

/** The checkouts whose `origin` names a forge repository. */
function withRemotes(checkouts: readonly EntryCheckout[]): LinkedCheckout[] {
  return checkouts.flatMap(({ path, remote }) => (remote ? [{ remote, path }] : []));
}

async function defaultLoadGitAutoMode(context: LaunchContext): Promise<boolean> {
  return (await context.configStore.load()).git === "auto";
}

async function defaultLoadCapabilities(context: LaunchContext): Promise<CapabilityConfig[]> {
  const config = await context.configStore.load();
  return config.capabilities ?? [];
}

/**
 * The companion, the Working Repository with its remote identity, and the configured
 * protected-branch patterns. `error` explains why the command cannot run; it is null
 * when the companion check has already reported the problem.
 */
export async function resolveDeliveryEnvironment(
  deps: DeliveryEnvironmentDeps,
): Promise<DeliveryEnvironment | { error: string | null }> {
  const ensureCompanion = deps.ensureUnambiguousCompanion ?? ensureUnambiguousCompanion;
  if (!(await ensureCompanion(process.cwd()))) return { error: null };

  let context: LaunchContext;
  try {
    context = await (deps.resolveContext ?? ((cwd: string) => resolveForCapability(cwd)))(
      process.cwd(),
    );
  } catch (err) {
    if (err instanceof WorkingRepoRequiredError) return { error: err.message };
    throw err;
  }

  const capabilities = await (deps.loadCapabilities ?? defaultLoadCapabilities)(context);
  if (!hasOpenspecCapability(capabilities)) {
    return { error: "mate: the openspec capability must be enabled to record delivery." };
  }

  const openGit = deps.workingRepoGit ?? workingRepoGit;
  const repoPath = context.repository?.path ?? process.env.MATE_REPO_PATH;
  const readOrigin = (checkout: string) => openGit(checkout).remoteUrl();
  let workingRepo: WorkingRepoInfo | null = null;
  // An Umbrella Repository has no `origin` of its own; its children name the repositories.
  const ownChildren = repoPath
    ? withRemotes(await umbrellaChildrenOf(repoPath, deps.readChildOrigin))
    : [];
  if (repoPath) {
    const git = openGit(repoPath);
    const remote = ownChildren.length > 0 ? null : await git.remoteUrl();
    const forgeRepo = remote ? parseRemote(remote) : null;
    workingRepo = {
      path: repoPath,
      slug: forgeRepo ? repositoryPath(forgeRepo) : null,
      forgeRepo,
      git,
      ...(ownChildren.length > 0
        ? { umbrellaChildren: ownChildren.map((child) => repositoryPath(child.remote)) }
        : {}),
    };
  }

  let linkedRemotes: Promise<LinkedCheckout[]> | undefined;
  // Read once, and only when a repository other than the Working Repository is looked up.
  const linked = (): Promise<LinkedCheckout[]> =>
    (linkedRemotes ??= (async () => {
      // An unreadable registry only loses hints; the Working Repository remains.
      const repositories = await (deps.loadLinkedRepositories ?? defaultLoadLinkedRepositories)(
        context,
      ).catch(() => []);
      // The Working Repository's own entry is skipped; an umbrella's children are in `ownChildren`.
      const checkouts = await Promise.all(
        repositories
          .filter((repository) => repository.path !== repoPath)
          .map((repository) => linkedCheckoutsOf(repository, readOrigin, deps.readChildOrigin)),
      );
      return [...ownChildren, ...withRemotes(checkouts.flat())];
    })());
  const linkedMatch = async (repository: string) =>
    (await linked()).find(({ remote }) => sameRepository(repositoryPath(remote), repository));
  const hostOf = async (repository: string): Promise<string | null> =>
    (await linkedMatch(repository))?.remote.host ?? workingRepo?.forgeRepo?.host ?? null;
  const checkoutOf = async (repository: string): Promise<string | null> => {
    if (workingRepo?.slug && sameRepository(workingRepo.slug, repository)) return workingRepo.path;
    return (await linkedMatch(repository))?.path ?? null;
  };
  const gitAutoMode = await (deps.loadGitAutoMode ?? defaultLoadGitAutoMode)(context).catch(
    () => false,
  );

  return {
    companionPath: context.companionPath,
    workingRepo,
    protectedPatterns: configuredProtectedPatterns(capabilities),
    ticket: configuredTicketFormat(capabilities),
    branchTemplate: configuredBranchTemplate(capabilities),
    hostOf,
    checkoutOf,
    gitAutoMode,
  };
}
