import {
  workingRepoGit,
  configuredProtectedPatterns,
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
import { WorkingRepoRequiredError } from "../../../../lib/orchestrator/types";
import { ensureUnambiguousCompanion } from "../../shared/companion-selection";

export interface DeliveryEnvironmentDeps {
  ensureUnambiguousCompanion?: (cwd: string) => Promise<boolean>;
  resolveContext?: (cwd: string) => Promise<LaunchContext>;
  loadCapabilities?: (context: LaunchContext) => Promise<CapabilityConfig[]>;
  workingRepoGit?: (repoPath: string) => WorkingRepoGit;
  loadLinkedRepositories?: (context: LaunchContext) => Promise<LinkedRepository[]>;
}

async function defaultLoadLinkedRepositories(context: LaunchContext): Promise<LinkedRepository[]> {
  return (await context.workingRepoStore.load()).repos;
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
  let workingRepo: WorkingRepoInfo | null = null;
  if (repoPath) {
    const git = openGit(repoPath);
    const remote = await git.remoteUrl();
    const forgeRepo = remote ? parseRemote(remote) : null;
    workingRepo = {
      path: repoPath,
      slug: forgeRepo ? repositoryPath(forgeRepo) : null,
      forgeRepo,
      git,
    };
  }

  let linkedRemotes: Promise<ForgeRepo[]> | undefined;
  // Read once, and only when a repository other than the Working Repository needs a host.
  const linked = (): Promise<ForgeRepo[]> =>
    (linkedRemotes ??= (async () => {
      // An unreadable registry only loses host hints; the Working Repository's host remains.
      const repositories = await (deps.loadLinkedRepositories ?? defaultLoadLinkedRepositories)(
        context,
      ).catch(() => []);
      const remotes = await Promise.all(
        repositories
          .filter((repository) => repository.path !== repoPath)
          .map((repository) => openGit(repository.path).remoteUrl()),
      );
      return remotes.flatMap((remote) => (remote ? (parseRemote(remote) ?? []) : []));
    })());
  const hostOf = async (repository: string): Promise<string | null> => {
    const match = (await linked()).find((remote) =>
      sameRepository(repositoryPath(remote), repository),
    );
    return match?.host ?? workingRepo?.forgeRepo?.host ?? null;
  };

  return {
    companionPath: context.companionPath,
    workingRepo,
    protectedPatterns: configuredProtectedPatterns(capabilities),
    hostOf,
  };
}
