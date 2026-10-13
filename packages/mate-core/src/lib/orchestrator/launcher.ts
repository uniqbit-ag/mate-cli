// oxlint-disable no-underscore-dangle
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { planClaudeDelivery, type SessionKind } from "../../runtime/claude-delivery-plan";
import { hookGroupKey, type ClaudeHookGroup } from "../../runtime/claude-hook-group";
import { NOT_WRAPPED } from "../../runtime/wrap-state";
import { writeAtomic } from "../../runtime/write-atomic";
import {
  getCompanionClaudeMcpConfigPath,
  getCompanionClaudeSettingsPath,
} from "../../tools/setup/providers/claude";
import type { ClaudeSettings } from "../../tools/setup/providers/claude-format";
import type { AdapterContext, ClaudeDelivery, LaunchAdapter } from "./adapters/base";
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

/** Where a launch with a Working Repository writes its derived `--settings`; git-ignored. */
export function launchSettingsPath(companionPath: string, repositoryId: string): string {
  const safeId = repositoryId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(companionPath, ".claude", "state", `launch-settings.${safeId}.json`);
}

/**
 * Companion settings minus `exclude`, so each wrap-carried group runs once. A
 * file, not inline JSON (platform arg limits); per repository, so concurrent
 * launches never race.
 */
async function writeLaunchSettings(
  companionSettingsPath: string,
  target: string,
  exclude: readonly ClaudeHookGroup[],
): Promise<void> {
  const settings = JSON.parse(await fs.readFile(companionSettingsPath, "utf8")) as ClaudeSettings;
  const excluded = new Set(exclude.map(hookGroupKey));
  const hooks: Record<string, ClaudeHookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const kept = (groups ?? []).filter((group) => !excluded.has(hookGroupKey(group)));
    if (kept.length > 0) hooks[event] = kept;
  }
  const derived: ClaudeSettings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete derived.hooks;

  await fs.mkdir(path.dirname(target), { recursive: true });
  await writeAtomic(target, `${JSON.stringify(derived, null, 2)}\n`);
}

/**
 * Plans from the wrap state the prepare's pass left, never a fresh read. A
 * repository left without a Claude wrap fails preflight: the plan would defer
 * to a wrap that is not there.
 */
async function claudeDeliveryFor(
  state: ResolvedLaunchState,
  prepared: PrepareResult,
): Promise<ClaudeDelivery> {
  const kind: SessionKind = state.repository ? "managed-repo" : "managed-companion";
  const wrap = prepared.wrapState ?? NOT_WRAPPED;
  if (state.repository && !wrap.runtimes.has("claude")) {
    throw new LaunchPreflightError(
      `${FRAMEWORK_NAME}: ${state.repository.id} is not wrapped for Claude after its prepare; run \`${FRAMEWORK_NAME} wrap\` in ${state.repository.path}.`,
    );
  }
  const plan = planClaudeDelivery(kind, wrap);
  const mcpConfigPath = getCompanionClaudeMcpConfigPath(state.companionPath);
  const delivery: ClaudeDelivery = {
    plan,
    ...(plan.mcp === "mcp-config" && existsSync(mcpConfigPath) ? { mcpConfigPath } : {}),
  };
  const companionSettingsPath = getCompanionClaudeSettingsPath(state.companionPath);
  if (plan.hooks.owner === "none" || !existsSync(companionSettingsPath)) return delivery;
  if (plan.hooks.owner === "settings") return { ...delivery, settingsPath: companionSettingsPath };
  /** Owner `wrap` is planned only for `managed-repo`, which has a repository. */
  const settingsPath = launchSettingsPath(state.companionPath, state.repository!.id);
  await writeLaunchSettings(companionSettingsPath, settingsPath, plan.hooks.launchSettingsExclude);
  return { ...delivery, settingsPath };
}

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
 * always has; a failed Claude wrap pass names the entry that failed; every
 * other launch raises the failed step's own error.
 */
function launchFailure(request: LaunchRequest, result: PrepareResult): unknown {
  if (request.tool === "opencode" && result.repositoryId) {
    return new LaunchPreflightError(prepareFailure(result));
  }
  const failed = result.steps.find((step) => step.outcome === "failed");
  if (request.tool === "claude" && failed?.step === "working-target") {
    return new LaunchPreflightError(
      `${FRAMEWORK_NAME}: reconciling the Claude wrap of ${result.repositoryId} failed: ${failed.detail ?? "failed"}`,
      { cause: result.failure },
    );
  }
  return result.failure ?? new LaunchPreflightError(prepareFailure(result));
}

/** The wrap notice is informational: `process.stderr.write`, since Bun renders `console.error` red. */
function report(result: PrepareResult): void {
  const wrapped = result.steps.find((step) => step.step === "working-target");
  if (wrapped?.outcome === "ok" && wrapped.detail !== "current") {
    const runtime = wrapped.runtimes?.includes("claude") ? "Claude" : "OpenCode";
    process.stderr.write(
      `${FRAMEWORK_NAME}: wrapped ${result.repositoryId} for ${runtime}: ${wrapped.detail}\n`,
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
   * prepares a bare session, and both load the same documents. For Claude it
   * reconciles an existing Claude wrap, and the adapter defers to it.
   */
  async prepare(request: LaunchRequest): Promise<PreparedLaunch> {
    const state = await this.resolveLaunchState(request);

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
    const adapterContext: AdapterContext = {
      ...this.makeAdapterContext(state),
      ...(request.tool === "claude"
        ? { claudeDelivery: await claudeDeliveryFor(state, prepared) }
        : {}),
    };
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
