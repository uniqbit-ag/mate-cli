import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";
import { buildCompanionGuidance } from "../../../playbooks/companion-guidance";
import { planClaudeDelivery, type ClaudeDeliveryPlan } from "../../../runtime/claude-delivery-plan";
import { hookGroupKey, type ClaudeHookGroup } from "../../../runtime/claude-hook-group";
import { resolveSecretPolicy } from "../../../runtime/policy";
import type { SessionKind } from "../../../runtime/session-kind";
import { NOT_WRAPPED } from "../../../runtime/wrap-state";
import { writeAtomic } from "../../../runtime/write-atomic";
import {
  getCompanionClaudeMcpConfigPath,
  getCompanionClaudeSettingsPath,
} from "../../../tools/setup/providers/claude";
import type { ClaudeSettings } from "../../../tools/setup/providers/claude-format";
import { getClaudePluginRoot, validateClaudePluginAssets } from "../../package-paths";
import type { PrepareResult } from "../session-prepare";
import { LaunchPreflightError } from "../types";
import { type AdapterContext, LaunchAdapter } from "./base";

/** The paths are present only where the plan names that channel and the file exists. */
interface ClaudeDelivery {
  plan: ClaudeDeliveryPlan;
  settingsPath?: string;
  mcpConfigPath?: string;
}

/** A Claude launch's context: the delivery its plan chose, and the files it chose or wrote. */
interface ClaudeLaunchContext extends AdapterContext {
  delivery: ClaudeDelivery;
  /** The Capability plugin folders this launch's own prepare gathered, in order. */
  pluginDirectories: readonly string[];
}

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

/** The `--settings` file the plan's hook owner calls for, writing it when derived. */
async function settingsPathFor(
  plan: ClaudeDeliveryPlan,
  companionPath: string,
  repository: AdapterContext["repository"],
): Promise<string | undefined> {
  const companionSettingsPath = getCompanionClaudeSettingsPath(companionPath);
  if (plan.hooks.owner === "none" || !existsSync(companionSettingsPath)) return undefined;
  if (plan.hooks.owner === "settings") return companionSettingsPath;
  /** Owner `wrap` is planned only for `managed-repo`, which has a repository. */
  const settingsPath = launchSettingsPath(companionPath, repository!.id);
  await writeLaunchSettings(companionSettingsPath, settingsPath, plan.hooks.launchSettingsExclude);
  return settingsPath;
}

export class ClaudeAdapter extends LaunchAdapter<ClaudeLaunchContext> {
  readonly toolName = "claude";
  readonly interactive = true;

  /**
   * Plans from the wrap state the prepare's pass left, never a fresh read. A
   * repository left without a Claude wrap fails preflight: the plan would defer
   * to a wrap that is not there.
   */
  async planLaunch(context: AdapterContext, prepared: PrepareResult): Promise<ClaudeLaunchContext> {
    const { repository, companionPath } = context;
    const kind: SessionKind = repository ? "managed-repo" : "managed-companion";
    const wrap = prepared.wrapState ?? NOT_WRAPPED;
    if (repository && !wrap.runtimes.has("claude")) {
      throw new LaunchPreflightError(
        `${FRAMEWORK_NAME}: ${repository.id} is not wrapped for Claude after its prepare; run \`${FRAMEWORK_NAME} wrap\` in ${repository.path}.`,
      );
    }
    const plan = planClaudeDelivery(kind, wrap);
    const mcpConfigPath = getCompanionClaudeMcpConfigPath(companionPath);
    const settingsPath = await settingsPathFor(plan, companionPath, repository);
    const delivery: ClaudeDelivery = {
      plan,
      ...(plan.mcp === "mcp-config" && existsSync(mcpConfigPath) ? { mcpConfigPath } : {}),
      ...(settingsPath ? { settingsPath } : {}),
    };
    return { ...context, delivery, pluginDirectories: prepared.claudePluginDirectories ?? [] };
  }

  /** A failed Claude wrap pass names the entry that failed. */
  launchFailure(prepared: PrepareResult): unknown {
    const failed = prepared.steps.find((step) => step.outcome === "failed");
    if (failed?.step === "working-target") {
      return new LaunchPreflightError(
        `${FRAMEWORK_NAME}: reconciling the Claude wrap of ${prepared.repositoryId} failed: ${failed.detail ?? "failed"}`,
        { cause: prepared.failure },
      );
    }
    return super.launchFailure(prepared);
  }

  async validateLaunch(_context: ClaudeLaunchContext): Promise<void> {
    /** The bundled plugin carries the artifact-path guard; never launch without it. */
    try {
      validateClaudePluginAssets();
    } catch (error) {
      throw new Error(
        `Mate Claude plugin is unavailable: ${(error as Error).message}. Reinstall mate to repair it.`,
        { cause: error },
      );
    }
  }

  /**
   * Plan in, flags out; decides nothing. `--append-system-prompt` is
   * unconditional and `--plugin-dir` follows the plan: no settings document can
   * carry either.
   */
  buildArgs(context: ClaudeLaunchContext, args: string[]): string[] {
    const { plan, settingsPath, mcpConfigPath } = context.delivery;
    /** Layered on the user's own sources so global skills and plugins still load. */
    const settingsArgs =
      plan.hooks.owner !== "none" && settingsPath
        ? ["--setting-sources", "user,project,local", "--settings", settingsPath]
        : [];
    const addDirArgs = plan.dirAccess === "add-dir" ? ["--add-dir", context.companionPath] : [];
    /** The bundled plugin from the running install first, then each gathered folder. */
    const pluginDirArgs =
      plan.plugins === "launch-flag"
        ? [getClaudePluginRoot(), ...context.pluginDirectories].flatMap((dir) => [
            "--plugin-dir",
            dir,
          ])
        : [];
    const mcpConfigArgs =
      plan.mcp === "mcp-config" && mcpConfigPath ? ["--mcp-config", mcpConfigPath] : [];

    return [
      ...addDirArgs,
      "--append-system-prompt",
      buildCompanionGuidance({
        ...context,
        secretGuardrails: resolveSecretPolicy(context.companionPath).guardrails,
      }),
      ...settingsArgs,
      ...mcpConfigArgs,
      ...pluginDirArgs,
      ...args,
    ];
  }

  extendEnvironment(_context: ClaudeLaunchContext): NodeJS.ProcessEnv {
    return {
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1",
    };
  }
}
