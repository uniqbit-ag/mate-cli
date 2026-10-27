/** Prepares a plain Claude session in a Claude-wrapped repository as `mate claude` would. */
import fs from "node:fs";

import { unmanagedClaudeDelivery } from "../runtime/claude-delivery-plan";
import { hasLaunchEnvironment } from "../runtime/env";
import { resolveProjection } from "../runtime/projection";
import { runtimeDirectoryPath, runtimeMateBin } from "../runtime/runtime-directory";
import {
  PREPARE_TIMEOUT_MS,
  spawnPrepareRunner,
  startDetachedPrepareSync,
  type PrepareRun,
  type PrepareRunner,
} from "../runtime/session-prepare-runner";
import { instructionHookPayload } from "./companion-instructions";
import { hookOutcome, runHook, type HookOutcome } from "./hook-io";
import type { HookEnv } from "./validate-artifact-path";

export interface SessionPrepareHookDeps {
  /** The runtime-directory launcher; `null` until a `mate` run wrote it. */
  mateBin: () => string | null;
  runner: (mateBin: string, repoPath: string) => PrepareRunner;
  startSync: (mateBin: string, repoPath: string) => void;
  timeoutMs: number;
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    return [`mate: session prepare failed: ${errorText(error)}`];
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
      `mate: session prepare skipped: ${runtimeDirectoryPath()} is missing; run \`mate\` once to repair it.`,
    ];
  }

  const local = reconciles
    ? await runLocalPhase(deps, mateBin, projectDir)
    : { ok: true, notes: [] };
  if (syncs) deps.startSync(mateBin, projectDir);

  const verdict = local.ok ? "warning" : "failed";
  return local.notes.map((note) => `mate: session prepare ${verdict}: ${note}`);
}

/**
 * The prepare, then the main thread's Companion Instructions: Claude Code runs
 * an event's hooks in parallel, and the prepare rewrites the companion's
 * `AGENTS.md` and `CLAUDE.md`, so a separate instruction hook could read them
 * stale or half written. Only the wrap's `--projected` copy delivers them.
 */
export async function runSessionStartHook(
  env: HookEnv,
  cwd: string,
  argv: readonly string[],
  input: unknown,
  deps: SessionPrepareHookDeps = sessionPrepareHookDeps,
): Promise<HookOutcome> {
  const notes = await guardedPrepareNotes(env, cwd, deps);
  const { hookSpecificOutput, systemMessage } = instructionHookPayload(env, cwd, argv, input) ?? {};
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
    (input) => runSessionStartHook(process.env, process.cwd(), argv, input),
    (error) => operatorMessage([`mate: session start hook failed: ${errorText(error)}`]),
  );
}
