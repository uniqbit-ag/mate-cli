import type { WorkingRepoGit } from "../../../../lib/delivery/branches";
import {
  linkedDeliveryEnvironment,
  type DeliveryEnvironment,
} from "../../../../lib/delivery/environment";
import { hasOpenspecCapability } from "../../../../lib/orchestrator/capabilities";
import {
  resolveForCapability,
  type LaunchContext,
} from "../../../../lib/orchestrator/framework-context";
import type { CapabilityConfig, LinkedRepository } from "../../../../lib/orchestrator/types";
import type { OriginReader } from "../../../../lib/orchestrator/umbrella-checkouts";
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

  const { loadLinkedRepositories, loadGitAutoMode } = deps;
  return linkedDeliveryEnvironment(
    context,
    capabilities,
    context.repository?.path ?? process.env.MATE_REPO_PATH,
    {
      ...(deps.workingRepoGit ? { workingRepoGit: deps.workingRepoGit } : {}),
      ...(deps.readChildOrigin ? { readChildOrigin: deps.readChildOrigin } : {}),
      ...(loadLinkedRepositories
        ? { loadLinkedRepositories: () => loadLinkedRepositories(context) }
        : {}),
      ...(loadGitAutoMode ? { loadGitAutoMode: () => loadGitAutoMode(context) } : {}),
    },
  );
}
