// oxlint-disable no-underscore-dangle
import { FRAMEWORK_NAME } from "../../framework";
import type { AdapterContext, LaunchAdapter } from "./adapters/base";
import { ClaudeAdapter } from "./adapters/claude";
import { OpenCodeAdapter } from "./adapters/opencode";
import { inheritedWrapRuntimes } from "./checkout-adoption";
import { entryAtCheckout } from "./registry-checkouts";
import { CompanionStore } from "./repository-link";
import { resolveForLaunch, type LaunchContext } from "./framework-context";
import { prepareSession, type PrepareResult, type PrepareRuntime } from "./session-prepare";
import {
  RepositoryNotSelectedError,
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
  inheritedWrapRuntimes,
};

/** The wrap notice is informational: `process.stderr.write`, since Bun renders `console.error` red. */
function report(result: PrepareResult): void {
  const wrapped = result.steps.find((step) => step.step === "working-target");
  if (wrapped?.outcome === "ok" && wrapped.detail !== "current") {
    const names = { claude: "Claude", opencode: "OpenCode" } as const;
    const runtime = (wrapped.runtimes ?? [result.runtime]).map((name) => names[name]).join(" and ");
    process.stderr.write(
      `${FRAMEWORK_NAME}: wrapped ${result.repositoryId} for ${runtime}: ${wrapped.detail}\n`,
    );
  }
  for (const warning of result.warnings) {
    console.error(`${FRAMEWORK_NAME}: warning: ${warning}`);
  }
}

/** A registry entry seen from the launch folder: a launch in another Checkout of its clone starts there. */
function atCheckout(entry: LinkedRepository | undefined): LinkedRepository | undefined {
  return entry && entryAtCheckout(entry, process.cwd());
}

export class FrameworkLauncher {
  private readonly adapters = new Map<string, LaunchAdapter>(
    [new ClaudeAdapter(), new OpenCodeAdapter()].map((adapter) => [adapter.toolName, adapter]),
  );

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
   * Session Prepare in its attended mode, then the adapter's share: it words a
   * failed prepare, plans what the launch delivers, and runs its own checks.
   * Each launch's plan travels in its own context, never on the adapter.
   */
  async prepare(request: LaunchRequest): Promise<PreparedLaunch> {
    const state = await this.resolveLaunchState(request);

    const prepared = await launcherDeps.prepareSession({
      runtime: request.tool as PrepareRuntime,
      ...(state.repository
        ? {
            adoptedRuntimes: await launcherDeps.inheritedWrapRuntimes(
              state.companionPath,
              state.repository,
            ),
          }
        : {}),
      companionPath: state.companionPath,
      repository: state.repository,
      mode: "attended",
      config: state.config,
      skipGit: state.skipGit,
    });
    report(prepared);
    if (!prepared.ok) throw state.adapter.launchFailure(prepared);
    const adapterContext = await state.adapter.planLaunch(this.makeAdapterContext(state), prepared);
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
    const store = new CompanionStore(companionPath, workingRepoStore);
    const scope = request.scope ?? "working-repo";
    const repository =
      scope === "companion"
        ? undefined
        : (localRepository ?? atCheckout(await store.getRepository(repositoryId)));
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
