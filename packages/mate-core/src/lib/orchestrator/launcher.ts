// oxlint-disable no-underscore-dangle
import path from "node:path";

import { syncCompanionFiles, syncWorkingRepoClaudeSettings } from "../../tools/setup";
import { getActiveDistribution } from "../../distribution";
import type { CapabilityPlugin, LaunchPreflightContext } from "../../tools/setup/plugin";
import type { LaunchAdapter, AdapterContext } from "./adapters/base";
import { ClaudeAdapter } from "./adapters/claude";
import { OpenCodeAdapter } from "./adapters/opencode";
import { CompanionRegistryStore } from "./companion-registry-store";
import { CompanionStore } from "./companion-store";
import { ConfigStore } from "./config-store";
import { syncCompanionGit } from "./companion-git-sync";
import { resolveSessionEnvelope, type SessionEnvelopeSelection } from "./session-envelope";
import {
  AmbiguousCompanionError,
  RepositoryNotSelectedError,
  LaunchPreflightError,
  ToolNotAllowedError,
  WorkingRepoRequiredError,
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
    } = await this.resolveConfig(request);
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

  private async resolveConfig(request: LaunchRequest): Promise<{
    configStore: ConfigStore;
    workingRepoStore: CompanionRegistryStore;
    companionPath: string;
    repositoryId: string;
    repository: LinkedRepository;
    contextKind: "working-repo";
  }> {
    const selection: SessionEnvelopeSelection | undefined = process.env.MATE_ARTIFACT_PATH
      ? {
          companionPath: process.env.MATE_ARTIFACT_PATH,
          ...(process.env.MATE_REPO_ID ? { repositoryId: process.env.MATE_REPO_ID } : {}),
          ...(process.env.MATE_REPO_PATH ? { repositoryPath: process.env.MATE_REPO_PATH } : {}),
        }
      : undefined;
    const resolution = await resolveSessionEnvelope({
      host: request.tool,
      cwd: process.cwd(),
      selection,
    });
    if (!resolution.envelope) {
      const first = resolution.diagnostics[0];
      if (first?.code === "selection-required") {
        throw new AmbiguousCompanionError(
          first.candidates.map((candidate) => candidate.companionPath),
        );
      }
      throw new WorkingRepoRequiredError();
    }

    const { companionRepositoryPath, repositoryLink } = resolution.envelope;
    const configDir = path.join(companionRepositoryPath, ".mate", "config");
    return {
      configStore: new ConfigStore(path.join(configDir, "framework.yaml")),
      workingRepoStore: new CompanionRegistryStore(path.join(configDir, "registry.yaml")),
      companionPath: companionRepositoryPath,
      repositoryId: repositoryLink.repository.id,
      repository: repositoryLink.repository,
      contextKind: "working-repo",
    };
  }
}
