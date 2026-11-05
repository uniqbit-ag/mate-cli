import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";
import { buildCompanionGuidance } from "../../../playbooks/companion-guidance";
import {
  launchPluginFolders,
  planClaudeDelivery,
  type ClaudeDeliveryPlan,
} from "../../../runtime/claude-delivery-plan";
import { hookGroupKey, type ClaudeHookGroup } from "../../../runtime/claude-hook-group";
import { MATE_ENV } from "../../../runtime/env-names";
import { SESSION_ORIGIN_ENV } from "../../../runtime/session-registry";
import { resolveSecretPolicy } from "../../../runtime/policy";
import { managedSessionKind } from "../../../runtime/session-kind";
import { NOT_WRAPPED } from "../../../runtime/wrap-state";
import { writeAtomic } from "../../../runtime/write-atomic";
import {
  getCompanionClaudeMcpConfigPath,
  getCompanionClaudeSettingsPath,
} from "../../../tools/setup/providers/claude";
import { definesUserClaudeAttribution } from "../../../tools/setup/providers/claude-attribution";
import { worktreePluginSourceConflicts } from "../../../tools/setup/providers/claude-worktree-plugins";
import {
  mergeClaudeHookGroups,
  type ClaudeSettings,
} from "../../../tools/setup/providers/claude-format";
import { getClaudePluginRoot, validateClaudePluginAssets } from "../../package-paths";
import type { PrepareResult } from "../session-prepare";
import { LaunchPreflightError } from "../types";
import { type AdapterContext, LaunchAdapter, type PreparedLaunch } from "./base";
import { APPEND_PROMPT_FLAG, liftAppendedPrompts } from "./claude-args";

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
 * launches never race. `--settings` outranks every file scope, so `attribution`
 * is dropped when the user or the repository sets its own, even one added
 * after the companion's last sync.
 */
async function writeLaunchSettings(
  companionSettingsPath: string,
  target: string,
  exclude: readonly ClaudeHookGroup[],
  repoRoot: string,
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
  if (definesUserClaudeAttribution({ repoRoot })) {
    delete derived.attribution;
  }

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
  await writeLaunchSettings(
    companionSettingsPath,
    settingsPath,
    plan.hooks.launchSettingsExclude,
    repository!.path,
  );
  return settingsPath;
}

/** `--bg`/`--background`: Claude runs the session in its own daemon and returns at once. */
export function isBackgroundLaunch(args: readonly string[]): boolean {
  return args.includes("--bg") || args.includes("--background");
}

const SETTINGS_FLAG = "--settings";
const BG_SETTINGS_PRUNE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Where a background launch writes its `--settings`, named by its content: a
 * launch with another environment never overwrites the file a running session
 * reads. Git-ignored.
 */
export function backgroundLaunchSettingsPath(
  companionPath: string,
  repositoryId: string | undefined,
  content: string,
): string {
  const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  return launchSettingsPath(companionPath, repositoryId ?? "companion").replace(
    /\.json$/,
    `.${hash}.bg.json`,
  );
}

/** Every `--settings` value (`--settings <x>` or `--settings=<x>`), and the args without them. */
function takeSettingsArgs(args: readonly string[]) {
  const values: string[] = [];
  const rest: string[] = [];
  let at = -1;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === SETTINGS_FLAG && index + 1 < args.length) {
      values.push(args[(index += 1)]!);
    } else if (arg.startsWith(`${SETTINGS_FLAG}=`)) {
      values.push(arg.slice(SETTINGS_FLAG.length + 1));
    } else {
      rest.push(arg);
      continue;
    }
    if (at < 0) at = rest.length;
  }
  return { values, rest, at };
}

/** A `--settings` value is a file path or inline JSON, as Claude reads it. */
async function readSettingsArg(value: string): Promise<ClaudeSettings> {
  const json = value.trimStart().startsWith("{") ? value : await fs.readFile(value, "utf8");
  return JSON.parse(json) as ClaudeSettings;
}

/** The names a background session takes from the launch, not the daemon. */
const LAUNCH_ENV_NAMES = [...Object.values(MATE_ENV), SESSION_ORIGIN_ENV];

const envOf = (settings: ClaudeSettings) => (settings.env ?? {}) as Record<string, string>;

/**
 * Merges `next` over `base` as Claude merges settings scopes: `env` per name,
 * hook groups appended per event, permission lists joined; other keys replaced.
 */
function mergeSettings(base: ClaudeSettings, next: ClaudeSettings): ClaudeSettings {
  const merged: ClaudeSettings = { ...base, ...next, env: { ...envOf(base), ...envOf(next) } };
  if (base.hooks && next.hooks) merged.hooks = mergeClaudeHookGroups(base.hooks, next.hooks);
  if (base.permissions && next.permissions) {
    const permissions: Record<string, unknown> = { ...base.permissions, ...next.permissions };
    for (const [key, value] of Object.entries(next.permissions)) {
      const before = (base.permissions as Record<string, unknown>)[key];
      if (Array.isArray(before) && Array.isArray(value)) {
        permissions[key] = [...new Set([...before, ...value])];
      }
    }
    merged.permissions = permissions as ClaudeSettings["permissions"];
  }
  return merged;
}

/** Drops background settings files no launch wrote for 30 days. */
async function pruneBackgroundSettings(dir: string, now = Date.now()): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((name) => name.endsWith(".bg.json"))
      .map(async (name) => {
        const file = path.join(dir, name);
        const stat = await fs.stat(file).catch(() => null);
        if (stat && now - stat.mtimeMs > BG_SETTINGS_PRUNE_MS) await fs.rm(file, { force: true });
      }),
  );
}

/**
 * Claude's daemon starts a background session with the daemon's environment,
 * not the launch's, so the launch environment travels in the `--settings`
 * file's `env` instead: every Mate name, empty when the launch leaves it
 * unset, so a value the daemon inherited elsewhere never shows through. The
 * process Mate starts carries no Mate name, so a daemon it starts inherits none.
 * Mate's and the user's `--settings` merge into that one file (`mergeSettings`).
 */
async function backgroundLaunch(
  context: ClaudeLaunchContext,
  launch: PreparedLaunch,
): Promise<PreparedLaunch> {
  const { values, rest, at } = takeSettingsArgs(launch.args);
  let base: ClaudeSettings = {};
  for (const value of values) {
    // oxlint-disable-next-line no-await-in-loop -- later settings win
    const next = await readSettingsArg(value);
    base = mergeSettings(base, next);
  }
  const sessionEnv: Record<string, string> = {};
  for (const name of LAUNCH_ENV_NAMES) {
    sessionEnv[name] = launch.env[name] ?? "";
  }
  if (launch.env.PATH) sessionEnv.PATH = launch.env.PATH;

  const settings = { ...base, env: { ...envOf(base), ...sessionEnv } };
  const content = `${JSON.stringify(settings, null, 2)}\n`;
  const target = backgroundLaunchSettingsPath(
    context.companionPath,
    context.repository?.id,
    content,
  );
  await fs.mkdir(path.dirname(target), { recursive: true });
  await pruneBackgroundSettings(path.dirname(target));
  await writeAtomic(target, content);
  const args = [...rest];
  args.splice(at < 0 ? 0 : at, 0, SETTINGS_FLAG, target);

  const env: NodeJS.ProcessEnv = { ...launch.env, PATH: process.env.PATH };
  for (const name of LAUNCH_ENV_NAMES) delete env[name];
  if (!env.PATH) delete env.PATH;
  return { ...launch, args, env };
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
    const kind = managedSessionKind(Boolean(repository));
    const wrap = prepared.wrapState ?? NOT_WRAPPED;
    if (repository && !wrap.runtimes.has("claude")) {
      throw new LaunchPreflightError(
        `${FRAMEWORK_NAME}: ${repository.id} is not wrapped for Claude after its prepare; run \`${FRAMEWORK_NAME} wrap\` in ${repository.path}.`,
      );
    }
    const pluginOverrides =
      repository && prepared.claudePluginDirectories?.length
        ? await worktreePluginSourceConflicts(repository.path, wrap.carriedClaudePlugins)
        : [];
    const plan = planClaudeDelivery(kind, wrap, pluginOverrides);
    const mcpConfigPath = getCompanionClaudeMcpConfigPath(companionPath);
    const settingsPath = await settingsPathFor(plan, companionPath, repository);
    const delivery: ClaudeDelivery = {
      plan,
      ...(plan.mcp === "mcp-config" && existsSync(mcpConfigPath) ? { mcpConfigPath } : {}),
      ...(settingsPath ? { settingsPath } : {}),
    };
    return { ...context, delivery, pluginDirectories: prepared.claudePluginDirectories ?? [] };
  }

  async prepareLaunch(context: ClaudeLaunchContext, args: string[]): Promise<PreparedLaunch> {
    const launch = await super.prepareLaunch(context, args);
    return isBackgroundLaunch(args) ? backgroundLaunch(context, launch) : launch;
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
   * unconditional: no settings document can carry it. It holds the Agent
   * Guidance alone; the Companion Instructions come from the wrap's session hook.
   * `--plugin-dir` passes the folders `launchPluginFolders` names, from the
   * running install's bundled plugin.
   */
  buildArgs(context: ClaudeLaunchContext, args: string[]): string[] {
    const { plan, settingsPath, mcpConfigPath } = context.delivery;
    /** Layered on the user's own sources so global skills and plugins still load. */
    const settingsArgs =
      plan.hooks.owner !== "none" && settingsPath
        ? ["--setting-sources", "user,project,local", "--settings", settingsPath]
        : [];
    const addDirArgs = plan.dirAccess === "add-dir" ? ["--add-dir", context.companionPath] : [];
    const pluginDirArgs = launchPluginFolders(
      plan,
      context.pluginDirectories,
      getClaudePluginRoot(),
    ).flatMap((dir) => ["--plugin-dir", dir]);
    const mcpConfigArgs =
      plan.mcp === "mcp-config" && mcpConfigPath ? ["--mcp-config", mcpConfigPath] : [];

    const guidance = buildCompanionGuidance({
      ...context,
      secretGuardrails: resolveSecretPolicy(context.companionPath).guardrails,
    });
    const { args: passthrough, prompts, boundary } = liftAppendedPrompts(args);
    const promptArgs = [APPEND_PROMPT_FLAG, [guidance, ...prompts].filter(Boolean).join("\n\n")];
    const launchArgs = [...settingsArgs, ...mcpConfigArgs, ...pluginDirArgs];

    if (boundary === undefined) {
      return [...addDirArgs, ...promptArgs, ...launchArgs, ...passthrough];
    }
    return [
      ...addDirArgs,
      ...launchArgs,
      ...passthrough.slice(0, boundary),
      ...promptArgs,
      ...passthrough.slice(boundary),
    ];
  }
}
