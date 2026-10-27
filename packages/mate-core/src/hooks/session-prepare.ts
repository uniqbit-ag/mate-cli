/** Prepares a plain Claude session in a Claude-wrapped repository as `mate claude` would. */
import fs from "node:fs";

import { unmanagedClaudeDelivery } from "../runtime/claude-delivery-plan";
import { hasLaunchEnvironment } from "../runtime/env";
import { FRAMEWORK_NAME } from "../runtime/framework";
import { PROJECTED_FLAG } from "../runtime/projected-flag";
import { resolveProjection } from "../runtime/projection";
import { runtimeDirectoryPath, runtimeMateBin } from "../runtime/runtime-directory";
import {
  PREPARE_TIMEOUT_MS,
  spawnPrepareRunner,
  startDetachedPrepareSync,
  type PrepareRun,
  type PrepareRunner,
} from "../runtime/session-prepare-runner";
import { instructionHookPayload, type InstructionHookDeps } from "./companion-instructions";
import { errorText, hookOutcome, runHook, type HookCall, type HookOutcome } from "./hook-io";
import type { HookEnv } from "./validate-artifact-path";

export interface SessionPrepareHookDeps {
  /** The runtime-directory launcher; `null` until a `mate` run wrote it. */
  mateBin: () => string | null;
  runner: (mateBin: string, repoPath: string) => PrepareRunner;
  startSync: (mateBin: string, repoPath: string) => void;
  timeoutMs: number;
  /** The main thread's instruction read, after the prepare. */
  instructions?: InstructionHookDeps;
}

export const sessionPrepareHookDeps: SessionPrepareHookDeps = {
  mateBin: () => {
    const launcher = runtimeMateBin();
    return fs.existsSync(launcher) ? launcher : null;
  },
  runner: spawnPrepareRunner,
  startSync: startDetachedPrepareSync,
  timeoutMs: PREPARE_TIMEOUT_MS,
};

/** `systemMessage` only: the model must never be told to repair the companion. */
function operatorMessage(lines: string[]): HookOutcome {
  return hookOutcome(lines.length > 0 ? { systemMessage: lines.join("\n") } : null);
}

async function runLocalPhase(
  deps: SessionPrepareHookDeps,
  mateBin: string,
  projectDir: string,
): Promise<PrepareRun> {
  const pending = deps.runner(mateBin, projectDir)({ sync: false, timeoutMs: deps.timeoutMs });
  try {
    return await pending;
  } catch (error) {
    return { ok: false, notes: [errorText(error)] };
  }
}

/**
 * Inert under a launch environment or where the plan gives it nothing to own.
 * Awaits the local phase within a bound, then starts Git sync detached. Always
 * exits zero: a failed prepare must not block the session.
 */
export async function runSessionPrepareHook(
  env: HookEnv,
  cwd: string = process.cwd(),
  deps: SessionPrepareHookDeps = sessionPrepareHookDeps,
): Promise<HookOutcome> {
  return operatorMessage(await guardedPrepareNotes(env, cwd, deps));
}

/** A prepare that throws becomes a note, so the instructions after it still go out. */
async function guardedPrepareNotes(
  env: HookEnv,
  cwd: string,
  deps: SessionPrepareHookDeps,
): Promise<string[]> {
  try {
    return await prepareNotes(env, cwd, deps);
  } catch (error) {
    return [`${FRAMEWORK_NAME}: session prepare failed: ${errorText(error)}`];
  }
}

async function prepareNotes(
  env: HookEnv,
  cwd: string,
  deps: SessionPrepareHookDeps,
): Promise<string[]> {
  if (hasLaunchEnvironment(env)) return [];
  const projectDir = env.CLAUDE_PROJECT_DIR || cwd;
  const projection = resolveProjection(projectDir);
  if (!projection) return [];
  const plan = unmanagedClaudeDelivery(projection.repoRoot);
  const reconciles = plan.reconcile === "prepare-hook";
  const syncs = plan.gitSync === "prepare-hook";
  if (!reconciles && !syncs) return [];

  const mateBin = deps.mateBin();
  if (!mateBin) {
    return [
      `${FRAMEWORK_NAME}: session prepare skipped: ${runtimeDirectoryPath()} is missing; run \`${FRAMEWORK_NAME}\` once to repair it.`,
    ];
  }

  const local = reconciles
    ? await runLocalPhase(deps, mateBin, projectDir)
    : { ok: true, notes: [] };
  if (syncs) deps.startSync(mateBin, projectDir);

  const verdict = local.ok ? "warning" : "failed";
  return local.notes.map((note) => `${FRAMEWORK_NAME}: session prepare ${verdict}: ${note}`);
}

/**
 * The prepare, then the main thread's Companion Instructions, in one hook:
 * Claude Code runs an event's hooks in parallel, and the prepare rewrites the
 * files the instructions are read from. Only the wrap's copy runs either. Older
 * wraps registered it bare, so a bare copy counts as the wrap's unless
 * `CLAUDE_PLUGIN_ROOT`, set for plugin hooks only, marks it as the plugin's.
 */
export async function runSessionStartHook(
  call: HookCall,
  deps: SessionPrepareHookDeps = sessionPrepareHookDeps,
): Promise<HookOutcome> {
  const { env, cwd } = call;
  let { argv } = call;
  if (!argv.includes(PROJECTED_FLAG)) {
    if (env.CLAUDE_PLUGIN_ROOT) return operatorMessage([]);
    argv = [...argv, PROJECTED_FLAG];
  }
  const notes = await guardedPrepareNotes(env, cwd, deps);
  const { hookSpecificOutput, systemMessage } =
    instructionHookPayload({ ...call, argv }, deps.instructions) ?? {};
  const messages = systemMessage ? [...notes, systemMessage] : notes;
  if (!hookSpecificOutput) return operatorMessage(messages);
  return hookOutcome({
    hookSpecificOutput,
    ...(messages.length > 0 ? { systemMessage: messages.join("\n") } : {}),
  });
}

/** Plugin-shim entry; exits zero even when reading its input fails. */
export function run(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  return runHook(
    (input) => runSessionStartHook({ env: process.env, cwd: process.cwd(), argv, input }),
    (error) =>
      operatorMessage([`${FRAMEWORK_NAME}: session start hook failed: ${errorText(error)}`]),
  );
}
