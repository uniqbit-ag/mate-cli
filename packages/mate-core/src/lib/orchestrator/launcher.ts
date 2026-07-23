// oxlint-disable no-underscore-dangle
import { syncCompanionFiles, syncWorkingRepoClaudeSettings } from "../../tools/setup";
import type { LaunchAdapter, AdapterContext } from "./adapters/base";
import { ClaudeAdapter } from "./adapters/claude";
import { OpenCodeAdapter } from "./adapters/opencode";
import { CompanionStore, resolvePolicyFromConfig } from "./companion-store";
import { syncCompanionGit } from "./companion-git-sync";
import { resolveForLaunch, type LaunchContext } from "./framework-context";
import {
  RepositoryNotSelectedError,
  ToolNotAllowedError,
  type FrameworkConfig,
  type LaunchRequest,
  type LaunchResult,
  type LinkedRepository,
  type PolicySettings,
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
  policy: PolicySettings;
  repository: LinkedRepository;
}

export const launcherDeps = {
  syncCompanionFiles,
  syncWorkingRepoClaudeSettings,
  syncCompanionGit,
};

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
      await launcherDeps.syncCompanionGit(state.companionPath, state.repository.path);
    }
    await launcherDeps.syncCompanionFiles(state.companionPath, state.config, state.repository.path);
    await launcherDeps.syncWorkingRepoClaudeSettings(
      state.repository.path,
      state.companionPath,
      state.config,
    );
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
    const policy = localRepository
      ? resolvePolicyFromConfig(config, [repository], repository.id)
      : await store.resolvePolicy(repository.id);
    if (!policy.allowedAgents.includes(request.tool)) {
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
      policy,
      repository,
    };
  }

  private makeAdapterContext(state: ResolvedLaunchState): AdapterContext {
    return {
      repository: state.repository,
      policy: state.policy,
      companionPath: state.companionPath,
      capabilities: state.config.capabilities ?? [],
      git: state.config.git,
    };
  }

  private async resolveConfig(): Promise<LaunchContext> {
    return resolveForLaunch(process.cwd());
  }
}
