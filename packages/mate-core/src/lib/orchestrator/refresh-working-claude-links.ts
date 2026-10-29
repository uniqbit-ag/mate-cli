import { readWrapState } from "../../runtime/wrap-state";
import { GlobalConfigStore } from "./global-config-store";
import { reconcileWorkingRepoClaudeCommandLinks } from "./projection-claude-commands";
import { reconcileWorkingRepoClaudeSkillLinks } from "./projection-claude-skills";
import { readCompanionRegistry } from "./repository-link";
import type { FrameworkConfig, LinkedRepository } from "./types";
import { errorMessage } from "../../runtime/error-message";

export interface LinkRefreshResult {
  /** Null when the companion's list of linked repositories could not be read. */
  repository: LinkedRepository | null;
  outcome: "written" | "current" | "failed";
  error?: string;
}

export interface LinkRefreshDeps {
  readRegistry: (companionPath: string) => Promise<LinkedRepository[]>;
  isWrappedForClaude: (repoPath: string) => Promise<boolean>;
  registeredCompanionPaths: () => Promise<string[]>;
  reconcileSkillLinks: typeof reconcileWorkingRepoClaudeSkillLinks;
  reconcileCommandLinks: typeof reconcileWorkingRepoClaudeCommandLinks;
}

const linkRefreshDeps: LinkRefreshDeps = {
  readRegistry: async (companionPath) => {
    try {
      return (await readCompanionRegistry(companionPath)).repos;
    } catch (error) {
      // No registry file means no linked repositories.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  },
  isWrappedForClaude: async (repoPath) => (await readWrapState(repoPath)).runtimes.has("claude"),
  registeredCompanionPaths: () => new GlobalConfigStore().list(),
  reconcileSkillLinks: reconcileWorkingRepoClaudeSkillLinks,
  reconcileCommandLinks: reconcileWorkingRepoClaudeCommandLinks,
};

/**
 * Re-links the companion's Claude skills and commands into every linked Claude-wrapped
 * Working Repository. Links only; runtime documents wait for the wrap pass. Failures
 * are reported per repository, never thrown.
 */
export async function refreshWorkingClaudeLinks(
  companionPath: string,
  config: FrameworkConfig,
  deps: LinkRefreshDeps = linkRefreshDeps,
): Promise<LinkRefreshResult[]> {
  const enabled = config.allowedAgents?.includes("claude") ?? false;
  const results: LinkRefreshResult[] = [];
  let registered: string[] | undefined;
  let repositories: LinkedRepository[];
  try {
    repositories = await deps.readRegistry(companionPath);
  } catch (error) {
    return [{ repository: null, outcome: "failed", error: errorMessage(error) }];
  }

  for (const repository of repositories) {
    try {
      if (!(await deps.isWrappedForClaude(repository.path))) continue;
      registered ??= await deps.registeredCompanionPaths();
      const skills = await deps.reconcileSkillLinks(
        repository.path,
        companionPath,
        enabled,
        registered,
      );
      const commands = await deps.reconcileCommandLinks(
        repository.path,
        companionPath,
        enabled,
        registered,
      );
      const written = skills === "written" || commands === "written";
      results.push({ repository, outcome: written ? "written" : "current" });
    } catch (error) {
      results.push({
        repository,
        outcome: "failed",
        error: errorMessage(error),
      });
    }
  }
  return results;
}
