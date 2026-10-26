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
import {
  buildCompanionInstructions,
  companionInstructionsUnavailableLine,
  type InstructionReader,
} from "../../../runtime/companion-instructions";
import { resolveSecretPolicy } from "../../../runtime/policy";
import type { SessionKind } from "../../../runtime/session-kind";
import { NOT_WRAPPED } from "../../../runtime/wrap-state";
import { writeAtomic } from "../../../runtime/write-atomic";
import {
  getCompanionClaudeMcpConfigPath,
  getCompanionClaudeSettingsPath,
} from "../../../tools/setup/providers/claude";
import { definesUserClaudeAttribution } from "../../../tools/setup/providers/claude-attribution";
import type { ClaudeSettings } from "../../../tools/setup/providers/claude-format";
import {
  getClaudePluginRoot,
  getWrapperBinPath,
  validateClaudePluginAssets,
} from "../../package-paths";
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
  /** Present when the plan gives the main thread's Companion Instructions to the appended prompt. */
  instructions?: string;
}

const APPEND_PROMPT_FLAG = "--append-system-prompt";
const SNAPSHOT_FLAG = "--system-prompt-snapshot";
const RESUME_FLAGS = new Set(["--resume", "--continue", "--from-pr", "--teleport"]);
/** The main command's short flags that take a value: Claude reads the rest of a cluster as that value, so `-dc` is a debug filter. */
const VALUE_SHORT_FLAGS = new Set(["d", "n", "w"]);

function flagArgs(args: readonly string[]): readonly string[] {
  const terminator = args.indexOf("--");
  return terminator === -1 ? args : args.slice(0, terminator);
}

function shortFlagsResume(arg: string): boolean {
  if (!/^-[A-Za-z]/.test(arg)) return false;
  for (const letter of arg.slice(1)) {
    if (letter === "r" || letter === "c") return true;
    if (VALUE_SHORT_FLAGS.has(letter) || !/^[A-Za-z]$/.test(letter)) return false;
  }
  return false;
}

function resumesConversation(flags: readonly string[]): boolean {
  return flags.some((arg) =>
    arg.startsWith("--") ? RESUME_FLAGS.has(arg.split("=")[0]!) : shortFlagsResume(arg),
  );
}

function setsSnapshotMode(flags: readonly string[]): boolean {
  return flags.some((arg) => arg === SNAPSHOT_FLAG || arg.startsWith(`${SNAPSHOT_FLAG}=`));
}

/**
 * The operator's own `--append-system-prompt` values, lifted out of `args`:
 * Claude keeps only the last such flag, so each would replace the policy and
 * the instructions instead of following them. A trailing flag without a value
 * stays, for Claude to reject. `boundary` is where a lifted flag stood before
 * an argument that is no flag: a variadic option such as `--add-dir` before
 * it would otherwise read that argument as its own value, so Mate's flag goes
 * there. Only the first such place is kept: Claude reads one prompt.
 */
function liftAppendedPrompts(args: readonly string[]): {
  args: string[];
  flags: string[];
  prompts: string[];
  boundary?: number;
} {
  const flags = flagArgs(args);
  const kept: string[] = [];
  const prompts: string[] = [];
  const liftedAt: number[] = [];
  for (let index = 0; index < flags.length; index += 1) {
    const arg = flags[index]!;
    if (arg === APPEND_PROMPT_FLAG && index + 1 < flags.length) {
      prompts.push(flags[index + 1]!);
      liftedAt.push(kept.length);
      index += 1;
    } else if (arg.startsWith(`${APPEND_PROMPT_FLAG}=`)) {
      prompts.push(arg.slice(APPEND_PROMPT_FLAG.length + 1));
      liftedAt.push(kept.length);
    } else {
      kept.push(arg);
    }
  }
  const passthrough = [...kept, ...args.slice(flags.length)];
  const boundary = liftedAt.find(
    (at) => at > 0 && at < passthrough.length && !passthrough[at]!.startsWith("-"),
  );
  return {
    args: passthrough,
    flags: kept,
    prompts,
    ...(boundary === undefined ? {} : { boundary }),
  };
}

/**
 * Read after the prepare's companion file sync, which recreates `AGENTS.md`
 * and repairs its markers, so a failure here is real: the launch stops rather
 * than start a session without the companion's rules.
 */
function readLaunchInstructions(
  read: InstructionReader,
  plan: ClaudeDeliveryPlan,
  companionPath: string,
  repository: AdapterContext["repository"],
): string | undefined {
  if (plan.instructions.main !== "append-prompt" || !repository) return undefined;
  const result = read({
    companionPath,
    repository,
    /** The same path the launch materializes as `MATE_WRAPPER_BIN_PATH`. */
    wrapperBinPath: getWrapperBinPath(),
    runtime: "claude",
  });
  if (result.kind === "unavailable") {
    throw new LaunchPreflightError(
      `${FRAMEWORK_NAME}: ${companionInstructionsUnavailableLine(result)}.`,
    );
  }
  return result.text;
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

export class ClaudeAdapter extends LaunchAdapter<ClaudeLaunchContext> {
  readonly toolName = "claude";
  readonly interactive = true;

  constructor(private readonly readInstructions: InstructionReader = buildCompanionInstructions) {
    super();
  }

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
    const instructions = readLaunchInstructions(
      this.readInstructions,
      plan,
      companionPath,
      repository,
    );
    const mcpConfigPath = getCompanionClaudeMcpConfigPath(companionPath);
    const settingsPath = await settingsPathFor(plan, companionPath, repository);
    const delivery: ClaudeDelivery = {
      plan,
      ...(plan.mcp === "mcp-config" && existsSync(mcpConfigPath) ? { mcpConfigPath } : {}),
      ...(settingsPath ? { settingsPath } : {}),
    };
    return {
      ...context,
      delivery,
      pluginDirectories: prepared.claudePluginDirectories ?? [],
      ...(instructions ? { instructions } : {}),
    };
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
   * unconditional: no settings document can carry it. A resumed or continued
   * conversation gets `--system-prompt-snapshot off`, so it reads the current
   * Companion Instructions rather than the ones recorded at its start.
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

    const policy = buildCompanionGuidance({
      ...context,
      secretGuardrails: resolveSecretPolicy(context.companionPath).guardrails,
    });
    const { args: passthrough, flags, prompts, boundary } = liftAppendedPrompts(args);
    const snapshotArgs =
      context.instructions && resumesConversation(flags) && !setsSnapshotMode(flags)
        ? [SNAPSHOT_FLAG, "off"]
        : [];
    const promptArgs = [
      APPEND_PROMPT_FLAG,
      [policy, context.instructions ?? "", ...prompts].filter(Boolean).join("\n\n"),
      ...snapshotArgs,
    ];
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
