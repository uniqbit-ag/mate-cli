import path from "node:path";

import {
  configuredProtectedPatterns,
  configuredTicketFormat,
  workingRepoGit,
  type TicketSetting,
  type WorkingRepoGit,
} from "./branches";
import { sameRepository } from "./record";
import { parseRemote, repositoryPath, type RemoteRepo } from "./remote";
import type { ArtifactType } from "./staging/artifact-type";
import type { Workflow } from "../workflow/declaration";
import type { FrameworkContext } from "../orchestrator/framework-context";
import type { CapabilityConfig, LinkedRepository } from "../orchestrator/types";
import {
  linkedCheckoutsOf,
  umbrellaChildrenOf,
  type EntryCheckout,
  type OriginReader,
} from "../orchestrator/umbrella-checkouts";

export interface WorkingRepoInfo {
  path: string;
  /** Full repository path from the `origin` remote (`acme/platform/api`), or null without one. */
  slug: string | null;
  git: WorkingRepoGit;
  /** Set when the Working Repository is an Umbrella Repository: its children's repository paths. */
  umbrellaChildren?: string[];
}

/** The companion, the Working Repository with its remote identity, and protected-branch patterns. */
export interface DeliveryEnvironment {
  companionPath: string;
  workingRepo: WorkingRepoInfo | null;
  protectedPatterns: string[];
  /** The companion's ticket setting; absent means `none`. */
  ticket?: TicketSetting;
  /**
   * Path of the repository's checkout linked on this machine: the Working Repository, a
   * Repository Link, or an Umbrella Repository child. The only way a repository is inspected.
   */
  checkoutOf?: (repository: string) => Promise<string | null>;
  /** The companion's Git mode is `auto`: merge checks fetch before reading local refs. */
  gitAutoMode?: boolean;
  /**
   * The declared artifact type the companion's submit handles, whose change folders the delivery
   * commands then work on; absent for the built-in type.
   */
  artifactType?: ArtifactType;
  /** The companion's Delivery Path, read once with `artifactType`; loaded on demand when absent. */
  workflow?: Workflow;
}

/** `dir` relative to the companion, with forward slashes. */
export function companionRelative(environment: DeliveryEnvironment, dir: string): string {
  return path.relative(environment.companionPath, dir).split(path.sep).join("/");
}

export interface LinkedEnvironmentDeps {
  workingRepoGit?: (repoPath: string) => WorkingRepoGit;
  loadLinkedRepositories?: (context: FrameworkContext) => Promise<LinkedRepository[]>;
  /** Reads an Umbrella Repository child's `origin`; raw config by default, as worktree planning reads it. */
  readChildOrigin?: OriginReader;
  /** True when the companion's Git mode is `auto`. */
  loadGitAutoMode?: (context: FrameworkContext) => Promise<boolean>;
}

async function defaultLoadLinkedRepositories(
  context: FrameworkContext,
): Promise<LinkedRepository[]> {
  return (await context.workingRepoStore.load()).repos;
}

async function defaultLoadGitAutoMode(context: FrameworkContext): Promise<boolean> {
  return (await context.configStore.load()).git === "auto";
}

/** A linked repository's checkout with its parsed `origin` remote. */
interface LinkedCheckout {
  remote: RemoteRepo;
  path: string;
}

/** The checkouts whose `origin` names a repository. */
function withRemotes(checkouts: readonly EntryCheckout[]): LinkedCheckout[] {
  return checkouts.flatMap(({ path: checkout, remote }) =>
    remote ? [{ remote, path: checkout }] : [],
  );
}

/**
 * The delivery environment of a resolved companion context: the Working Repository at
 * `repoPath` with its `origin` identity, and the checkouts the companion's registry links on
 * this machine, read once on the first lookup of another repository.
 */
export async function linkedDeliveryEnvironment(
  context: FrameworkContext,
  capabilities: CapabilityConfig[],
  repoPath: string | undefined,
  deps: LinkedEnvironmentDeps = {},
): Promise<DeliveryEnvironment> {
  const openGit = deps.workingRepoGit ?? workingRepoGit;
  const readOrigin = (checkout: string) => openGit(checkout).remoteUrl();
  let workingRepo: WorkingRepoInfo | null = null;
  // An Umbrella Repository has no `origin` of its own; its children name the repositories.
  const ownChildren = repoPath
    ? withRemotes(await umbrellaChildrenOf(repoPath, deps.readChildOrigin))
    : [];
  if (repoPath) {
    const git = openGit(repoPath);
    const remote = ownChildren.length > 0 ? null : await git.remoteUrl();
    const parsed = remote ? parseRemote(remote) : null;
    workingRepo = {
      path: repoPath,
      slug: parsed ? repositoryPath(parsed) : null,
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
      // An unreadable registry only loses links; the Working Repository remains.
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
  const checkoutOf = async (repository: string): Promise<string | null> => {
    if (workingRepo?.slug && sameRepository(workingRepo.slug, repository)) return workingRepo.path;
    const match = (await linked()).find(({ remote }) =>
      sameRepository(repositoryPath(remote), repository),
    );
    return match?.path ?? null;
  };
  const gitAutoMode = await (deps.loadGitAutoMode ?? defaultLoadGitAutoMode)(context).catch(
    () => false,
  );

  return {
    companionPath: context.companionPath,
    workingRepo,
    protectedPatterns: configuredProtectedPatterns(capabilities),
    ticket: configuredTicketFormat(capabilities),
    checkoutOf,
    gitAutoMode,
  };
}
