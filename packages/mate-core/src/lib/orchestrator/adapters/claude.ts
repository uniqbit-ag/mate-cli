import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";
import { buildCompanionGuidance } from "../../../playbooks/companion-guidance";
import {
  planClaudeDelivery,
  type ClaudeDeliveryPlan,
  type SessionKind,
} from "../../../runtime/claude-delivery-plan";
import {
  audienceLayerDir,
  currentAudienceLayer,
  readLayerGuidanceSync,
} from "../../../runtime/audience-layer";
import { hookGroupKey, type ClaudeHookGroup } from "../../../runtime/claude-hook-group";
import { NOT_WRAPPED } from "../../../runtime/wrap-state";
import { writeAtomic } from "../../../runtime/write-atomic";
import {
  getCompanionClaudeMcpConfigPath,
  getCompanionClaudeSettingsPath,
} from "../../../tools/setup/providers/claude";
import type { ClaudeSettings } from "../../../tools/setup/providers/claude-format";
import { getContextModePackageRoot, validateContextModePackage } from "../../context-mode-package";
import { getClaudePluginRoot, validateClaudePluginAssets } from "../../package-paths";
import type { RenderedAudienceLayer } from "../../../tools/setup/audience-layer";
import type { PrepareResult } from "../session-prepare";
import { LaunchPreflightError } from "../types";
import { type AdapterContext, LaunchAdapter } from "./base";

/** The active audience's layer, attached to this launch only. */
interface ClaudeLayerDelivery {
  audience: string;
  root: string;
  /** The layer's MCP configuration, when the layer holds one. */
  mcpConfigPath?: string;
}

/** The paths are present only where the plan names that channel and the file exists. */
interface ClaudeDelivery {
  plan: ClaudeDeliveryPlan;
  settingsPath?: string;
  mcpConfigPath?: string;
  layer?: ClaudeLayerDelivery;
  /**
   * The guidance of the audience the checkout is wrapped for. The wrap carries
   * the rest of that audience; its guidance hook stays silent in a managed
   * session, so the launch's own system prompt carries this.
   */
  wrappedGuidance?: string;
}

/** A Claude launch's context: the delivery its plan chose, and the files it chose or wrote. */
interface ClaudeLaunchContext extends AdapterContext {
  delivery: ClaudeDelivery;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Where a launch writes its derived `--settings`. Per Working Repository and
 * audience, so concurrent launches never race; a companion-scoped launch
 * derives one only for an audience. Without an audience it is git-ignored
 * under the companion. With one it carries that audience's hooks and
 * permission entries, so it lives beside the audience's layer, outside the
 * companion, where no other audience's session can read it.
 */
export function launchSettingsPath(
  companionPath: string,
  repositoryId: string | null,
  audience?: string,
): string {
  const scope = repositoryId === null ? "companion-scope" : `settings.${safeName(repositoryId)}`;
  if (audience) {
    return path.join(audienceLayerDir(companionPath, audience), `launch-${scope}.json`);
  }
  return path.join(companionPath, ".claude", "state", `launch-${scope}.json`);
}

async function readSettings(settingsPath: string): Promise<ClaudeSettings> {
  if (!existsSync(settingsPath)) return {};
  return JSON.parse(await fs.readFile(settingsPath, "utf8")) as ClaudeSettings;
}

/**
 * Companion settings minus `exclude`, so each wrap-carried group runs once,
 * plus the layer's hook groups and permission entries. A file, not inline JSON
 * (platform arg limits). Claude reads one `--settings` file only — a second
 * one replaces the first — so the layer is merged here, never passed beside.
 */
async function writeLaunchSettings(
  companionSettingsPath: string,
  target: string,
  exclude: readonly ClaudeHookGroup[],
  layerSettingsPath?: string,
): Promise<void> {
  const settings = await readSettings(companionSettingsPath);
  const layer = layerSettingsPath ? await readSettings(layerSettingsPath) : {};
  const excluded = new Set(exclude.map(hookGroupKey));
  const hooks: Record<string, ClaudeHookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const kept = (groups ?? []).filter((group) => !excluded.has(hookGroupKey(group)));
    if (kept.length > 0) hooks[event] = kept;
  }
  for (const [event, groups] of Object.entries(layer.hooks ?? {})) {
    hooks[event] = [...(hooks[event] ?? []), ...(groups ?? [])];
  }
  const derived: ClaudeSettings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete derived.hooks;
  const layerAllow = layer.permissions?.allow ?? [];
  if (layerAllow.length > 0) {
    const allow = [...new Set([...(settings.permissions?.allow ?? []), ...layerAllow])];
    derived.permissions = { ...settings.permissions, allow };
  }

  const text = `${JSON.stringify(derived, null, 2)}\n`;
  if (layerSettingsPath) {
    /** Beside the audience's layer: as private as the layer itself. */
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeAtomic(target, text, 0o600);
  } else {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await writeAtomic(target, text);
  }
}

/** The `--settings` file the plan's hook owner calls for, writing it when derived. */
async function settingsPathFor(
  plan: ClaudeDeliveryPlan,
  companionPath: string,
  repository: AdapterContext["repository"],
  layer: RenderedAudienceLayer | undefined,
): Promise<string | undefined> {
  const companionSettingsPath = getCompanionClaudeSettingsPath(companionPath);
  if (plan.hooks.owner === "none") return undefined;
  if (!layer && !existsSync(companionSettingsPath)) return undefined;
  if (plan.hooks.owner === "settings" && !layer) return companionSettingsPath;
  /** Owner `wrap` is planned only for `managed-repo`, which has a repository. */
  const settingsPath = launchSettingsPath(
    companionPath,
    plan.hooks.owner === "wrap" ? repository!.id : null,
    layer?.audience,
  );
  await writeLaunchSettings(
    companionSettingsPath,
    settingsPath,
    plan.hooks.launchSettingsExclude,
    layer ? getCompanionClaudeSettingsPath(layer.root) : undefined,
  );
  return settingsPath;
}

/** The layer as this launch attaches it: the directory, and its MCP configuration when present. */
function layerDelivery(layer: RenderedAudienceLayer | undefined): ClaudeLayerDelivery | undefined {
  if (!layer) return undefined;
  const mcpConfigPath = getCompanionClaudeMcpConfigPath(layer.root);
  return {
    audience: layer.audience,
    root: layer.root,
    ...(existsSync(mcpConfigPath) ? { mcpConfigPath } : {}),
  };
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
    const settingsPath = await settingsPathFor(
      plan,
      companionPath,
      repository,
      prepared.audienceLayer,
    );
    const layer = layerDelivery(prepared.audienceLayer);
    const wrappedLayer =
      !layer && wrap.audience ? currentAudienceLayer(companionPath, wrap.audience) : null;
    const wrappedGuidance = wrappedLayer ? readLayerGuidanceSync(wrappedLayer, "CLAUDE.md") : "";
    const delivery: ClaudeDelivery = {
      plan,
      ...(plan.mcp === "mcp-config" && existsSync(mcpConfigPath) ? { mcpConfigPath } : {}),
      ...(settingsPath ? { settingsPath } : {}),
      ...(layer ? { layer } : {}),
      ...(wrappedGuidance ? { wrappedGuidance } : {}),
    };
    return { ...context, delivery };
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

  async validateLaunch(context: ClaudeLaunchContext): Promise<void> {
    /** The bundled plugin carries the artifact-path guard; never launch without it. */
    try {
      validateClaudePluginAssets();
    } catch (error) {
      throw new Error(
        `Mate Claude plugin is unavailable: ${(error as Error).message}. Reinstall mate to repair it.`,
        { cause: error },
      );
    }

    if (context.capabilities.some((capability) => capability.name === "context-mode")) {
      try {
        await validateContextModePackage(context.companionPath);
      } catch (error) {
        throw new Error(
          `Claude context-mode plugin is unavailable: ${(error as Error).message} Repair it with \`mate companion setup\`.`,
          { cause: error },
        );
      }
    }
  }

  /**
   * Plan in, flags out; decides nothing. `--append-system-prompt`, `--plugin-dir`
   * and context-mode are unconditional: no settings document can carry them.
   */
  buildArgs(context: ClaudeLaunchContext, args: string[]): string[] {
    const { plan, settingsPath, mcpConfigPath, layer, wrappedGuidance } = context.delivery;
    const companionGuidance = buildCompanionGuidance(context);
    const systemPrompt = wrappedGuidance
      ? `${companionGuidance}\n\n${wrappedGuidance}`
      : companionGuidance;
    /** Layered on the user's own sources so global skills and plugins still load. */
    const settingsArgs =
      plan.hooks.owner !== "none" && settingsPath
        ? ["--setting-sources", "user,project,local", "--settings", settingsPath]
        : [];
    /**
     * The layer adds its skills, commands, agents and `CLAUDE.md` as one more
     * directory, and its MCP servers as one more configuration beside every
     * server the launch delivered before. Both flags are variadic, so each is
     * followed by another flag, never by the operator's arguments.
     */
    const addDirArgs = [
      ...(plan.dirAccess === "add-dir" ? ["--add-dir", context.companionPath] : []),
      ...(layer ? ["--add-dir", layer.root] : []),
    ];
    const mcpConfigArgs = [
      ...(plan.mcp === "mcp-config" && mcpConfigPath ? ["--mcp-config", mcpConfigPath] : []),
      ...(layer?.mcpConfigPath ? ["--mcp-config", layer.mcpConfigPath] : []),
    ];
    const contextModeArgs = context.capabilities.some(
      (capability) => capability.name === "context-mode",
    )
      ? ["--plugin-dir", getContextModePackageRoot(context.companionPath)]
      : [];

    return [
      ...addDirArgs,
      "--append-system-prompt",
      systemPrompt,
      ...settingsArgs,
      ...mcpConfigArgs,
      /** The bundled plugin from the running install, beside context-mode's. */
      "--plugin-dir",
      getClaudePluginRoot(),
      ...contextModeArgs,
      ...args,
    ];
  }

  extendEnvironment(_context: ClaudeLaunchContext): NodeJS.ProcessEnv {
    return {
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1",
    };
  }
}
