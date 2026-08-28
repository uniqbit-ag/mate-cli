// oxlint-disable no-underscore-dangle
import { renderWorkingRuntimeDocuments, syncCompanionFiles } from "../../tools/setup";
import { getActiveDistribution } from "../../distribution";
import { FRAMEWORK_NAME } from "../../framework";
import type { CapabilityPlugin, LaunchPreflightContext } from "../../tools/setup/plugin";
import type { LaunchAdapter, AdapterContext } from "./adapters/base";
import { ClaudeAdapter } from "./adapters/claude";
import { OpenCodeAdapter } from "./adapters/opencode";
import { CompanionStore } from "./companion-store";
import { syncCompanionGit } from "./companion-git-sync";
import { resolveForLaunch, type LaunchContext } from "./framework-context";
import {
  firstFailure,
  type ProjectionEntryOutcome,
  type ProjectionInput,
  type ProjectionResult,
} from "./projection-types";
import { project, projectWorkingRepositoryBestEffort } from "./working-repo-projection";
import {
  RepositoryNotSelectedError,
  LaunchPreflightError,
  ToolNotAllowedError,
  type FrameworkConfig,
  type LaunchRequest,
  type LaunchResult,
  type LinkedRepository,
} from "./types";

export interface LaunchPreview {
  tool: string;
  repositoryId: string;
  repositoryPath: string;
  companionPath: string;
}

export interface PreparedLaunch {
  execute(): Promise<LaunchResult>;
}

interface ResolvedLaunchState {
  adapter: LaunchAdapter;
  companionPath: string;
  config: FrameworkConfig;
  repository: LinkedRepository;
}

export const launcherDeps = {
  syncCompanionFiles,
  /**
   * The same render `mate wrap` hands the projection, from the same companion,
   * configuration and Working Repository — so a launch refreshes the pins the
   * documents carry instead of leaving a repository on whichever release
   * wrapped it, and so no document a wrap placed is withdrawn for having been
   * left out of the launch's render.
   */
  renderRuntimeDocuments: renderWorkingRuntimeDocuments,
  /** The Managed Projection's launch scope; the working repo is written only here. */
  projectWorkingRepo: (input: ProjectionInput) => project("launch", input),
  /**
   * The Projection Root a launch guarantees for itself. `resolveForLaunch` also
   * writes it, but only on the branch that resolved a companion from the
   * Working Repository; asking here makes the guarantee independent of which
   * branch answered. Best-effort — a launch carries its own configuration.
   */
  refreshProjectionRoot: projectWorkingRepositoryBestEffort,
  syncCompanionGit,
};

/**
 * The shape `projectWorkingRepositoryBestEffort` reports a failed projection
 * in, narrowed to the entry that failed: the launch scope writes several, so
 * "the projection" alone would not tell the operator what to fix.
 */
function projectionFailure(outcome: ProjectionEntryOutcome, repository: LinkedRepository): string {
  const error = outcome.error ?? new Error("projection failed");
  return `failed to write ${outcome.path} for ${repository.id}: ${error.message}`;
}

export class FrameworkLauncher {
  private readonly adapters = new Map<string, LaunchAdapter>([
    ["claude", new ClaudeAdapter()],
    ["opencode", new OpenCodeAdapter()],
  ]);

  async resolveLaunchPreview(request: LaunchRequest): Promise<LaunchPreview> {
    const state = await this.resolveLaunchState(request);
    return {
      tool: request.tool,
      repositoryId: state.repository.id,
      repositoryPath: state.repository.path,
      companionPath: state.companionPath,
    };
  }

  async prepare(request: LaunchRequest): Promise<PreparedLaunch> {
    const state = await this.resolveLaunchState(request);
    const adapterContext = this.makeAdapterContext(state);

    if (!request.skipGit && state.config.git === "auto") {
      await launcherDeps.syncCompanionGit(
        state.companionPath,
        state.repository.path,
        request.interactiveGit ?? false,
      );
    }
    await launcherDeps.syncCompanionFiles(state.companionPath, state.config, state.repository.path);
    this.answerForProjection(
      await launcherDeps.projectWorkingRepo({
        repoPath: state.repository.path,
        companionPath: state.companionPath,
        config: state.config,
        runtimeDocuments: await launcherDeps.renderRuntimeDocuments(
          state.companionPath,
          state.config,
          state.repository.path,
        ),
      }),
      state.repository,
    );
    await launcherDeps.refreshProjectionRoot(state.companionPath, state.repository);
    await this.runCapabilityPreflight(state, request.tool);
    await state.adapter.validateLaunch(adapterContext);

    return {
      execute: async () => state.adapter.run(adapterContext, request.args),
    };
  }

  async launch(request: LaunchRequest): Promise<LaunchResult> {
    return (await this.prepare(request)).execute();
  }

  private async resolveLaunchState(request: LaunchRequest): Promise<ResolvedLaunchState> {
    const {
      configStore,
      workingRepoStore,
      companionPath,
      repositoryId,
      repository: localRepository,
    } = await this.resolveConfig();
    const store = new CompanionStore(configStore, workingRepoStore);
    const repository = localRepository ?? (await store.getRepository(repositoryId));
    if (!repository) {
      throw new RepositoryNotSelectedError(`Linked repository not found: ${repositoryId}`);
    }

    const config = await configStore.load();
    if (!config.allowedAgents.includes(request.tool)) {
      throw new ToolNotAllowedError(`Tool is disallowed by policy: ${request.tool}`);
    }

    const adapter = this.adapters.get(request.tool);
    if (!adapter) {
      throw new ToolNotAllowedError(`Unsupported tool adapter: ${request.tool}`);
    }

    return {
      adapter,
      companionPath,
      config,
      repository,
    };
  }

  /**
   * `project` reports its failures rather than throwing, so the launch scope's
   * caller is the one that has to answer for them. A non-degradable entry is a
   * guardrail the session was promised — writing the companion into the
   * runtime's allow-list, for one — so the launch fails instead of starting
   * without it. A degradable entry warns in the voice
   * {@link projectWorkingRepositoryBestEffort} uses, and the launch proceeds.
   */
  private answerForProjection(result: ProjectionResult, repository: LinkedRepository): void {
    for (const outcome of result.outcomes) {
      if (outcome.state !== "failed" || !outcome.degradable) continue;
      console.error(`${FRAMEWORK_NAME}: warning: ${projectionFailure(outcome, repository)}`);
    }

    const failure = firstFailure(result.outcomes);
    if (failure) {
      throw new LaunchPreflightError(
        `${FRAMEWORK_NAME}: ${projectionFailure(failure, repository)}`,
      );
    }
  }

  private makeAdapterContext(state: ResolvedLaunchState): AdapterContext {
    return {
      repository: state.repository,
      allowedAgents: state.config.allowedAgents,
      companionPath: state.companionPath,
      capabilities: state.config.capabilities ?? [],
      git: state.config.git,
    };
  }

  private async runCapabilityPreflight(
    state: ResolvedLaunchState,
    providerId: string,
  ): Promise<void> {
    const context: LaunchPreflightContext = {
      companionPath: state.companionPath,
      config: state.config,
      repository: state.repository,
      providerId,
    };
    const preflights = getActiveDistribution()
      .registry.getAll()
      .reduce<
        Array<{
          capability: CapabilityPlugin;
          preflight: NonNullable<NonNullable<CapabilityPlugin["forProvider"]>[string]["preflight"]>;
        }>
      >((entries, plugin) => {
        if (plugin.kind !== "capability" || !plugin.isEnabled(state.config)) return entries;
        const capability = plugin as CapabilityPlugin;
        const preflight = capability.forProvider?.[providerId]?.preflight;
        if (preflight) entries.push({ capability, preflight });
        return entries;
      }, []);
    const results = await Promise.all(
      preflights.map(async ({ capability, preflight }) => {
        try {
          return await preflight(context);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new LaunchPreflightError(
            `Capability preflight failed for ${capability.id} on ${providerId}: ${detail}`,
            { cause: error },
          );
        }
      }),
    );
    const diagnostics = results.flat();

    if (diagnostics.length > 0) {
      throw new LaunchPreflightError(
        ["Capability launch preflight failed.", ...diagnostics.map((item) => `- ${item}`)].join(
          "\n",
        ),
      );
    }
  }

  private async resolveConfig(): Promise<LaunchContext> {
    return resolveForLaunch(process.cwd());
  }
}
