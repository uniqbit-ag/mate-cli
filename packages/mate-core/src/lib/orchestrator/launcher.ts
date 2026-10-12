// oxlint-disable no-underscore-dangle
import { FRAMEWORK_NAME } from "../../framework";
import type { LaunchAdapter, AdapterContext } from "./adapters/base";
import { ClaudeAdapter } from "./adapters/claude";
import { OpenCodeAdapter } from "./adapters/opencode";
import { CompanionStore } from "./companion-store";
import { resolveForLaunch, type LaunchContext } from "./framework-context";
import { prepareSession, type PrepareResult, type PrepareRuntime } from "./session-prepare";
import {
  RepositoryNotSelectedError,
  LaunchPreflightError,
  ToolNotAllowedError,
  type FrameworkConfig,
  type LaunchRequest,
  type LaunchResult,
  type LinkedRepository,
  type LaunchScope,
} from "./types";

export interface LaunchPreview {
  tool: string;
  repositoryId?: string;
  repositoryPath?: string;
  companionPath: string;
}

export interface PreparedLaunch {
  execute(): Promise<LaunchResult>;
}

interface ResolvedLaunchState {
  adapter: LaunchAdapter;
  companionPath: string;
  config: FrameworkConfig;
  repository?: LinkedRepository;
  scope: LaunchScope;
  launchWorkingDirectory: string;
  skipGit: boolean;
}

export const launcherDeps = {
  prepareSession,
};

function prepareFailure(result: PrepareResult): string {
  return [
    `${FRAMEWORK_NAME}: preparing ${result.repositoryId} for OpenCode failed.`,
    ...result.steps.flatMap((step) =>
      step.outcome === "failed" ? [`- ${step.step}: ${step.detail ?? "failed"}`] : [],
    ),
  ].join("\n");
}

/**
 * A prepared OpenCode repository reports its failure as one summary, as it
 * always has; every other launch raises the failed step's own error.
 */
function launchFailure(request: LaunchRequest, result: PrepareResult): unknown {
  if (request.tool === "opencode" && result.repositoryId) {
    return new LaunchPreflightError(prepareFailure(result));
  }
  return result.failure ?? new LaunchPreflightError(prepareFailure(result));
}

/** The wrap notice is informational: `process.stderr.write`, since Bun renders `console.error` red. */
function report(result: PrepareResult): void {
  const wrapped = result.steps.find((step) => step.step === "working-target");
  if (wrapped?.outcome === "ok" && wrapped.detail !== "current") {
    process.stderr.write(
      `${FRAMEWORK_NAME}: wrapped ${result.repositoryId} for OpenCode: ${wrapped.detail}\n`,
    );
  }
  for (const warning of result.warnings) {
    console.error(`${FRAMEWORK_NAME}: warning: ${warning}`);
  }
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
      companionPath: state.companionPath,
      ...(state.repository
        ? { repositoryId: state.repository.id, repositoryPath: state.repository.path }
        : {}),
    };
  }

  /**
   * Session Prepare in its attended mode, then the adapter's own checks. For
   * OpenCode a managed launch is a wrap followed by a plain launch, so the
   * prepare wraps a missing or stale OpenCode wrap exactly as the plugin
   * prepares a bare session, and both load the same documents.
   */
  async prepare(request: LaunchRequest): Promise<PreparedLaunch> {
    const state = await this.resolveLaunchState(request);
    const adapterContext = this.makeAdapterContext(state);

    const prepared = await launcherDeps.prepareSession({
      runtime: request.tool as PrepareRuntime,
      companionPath: state.companionPath,
      repository: state.repository,
      mode: "attended",
      config: state.config,
      skipGit: state.skipGit,
    });
    report(prepared);
    if (!prepared.ok) throw launchFailure(request, prepared);
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
    } = await this.resolveConfig(request.scope);
    const store = new CompanionStore(configStore, workingRepoStore);
    const scope = request.scope ?? "working-repo";
    const repository =
      scope === "companion"
        ? undefined
        : (localRepository ?? (await store.getRepository(repositoryId)));
    if (scope === "working-repo" && !repository) {
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
      scope,
      launchWorkingDirectory: scope === "companion" ? companionPath : repository!.path,
      skipGit: request.skipGit ?? false,
    };
  }

  private makeAdapterContext(state: ResolvedLaunchState): AdapterContext {
    return {
      repository: state.repository,
      allowedAgents: state.config.allowedAgents,
      companionPath: state.companionPath,
      launchWorkingDirectory: state.launchWorkingDirectory,
      capabilities: state.config.capabilities ?? [],
      git: state.config.git,
      skipGit: state.skipGit,
    };
  }

  private async resolveConfig(scope: LaunchScope = "working-repo"): Promise<LaunchContext> {
    return resolveForLaunch(process.cwd(), undefined, scope);
  }
}
