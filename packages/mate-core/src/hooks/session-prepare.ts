/** Prepares a plain Claude session in a Claude-wrapped repository as `mate claude` would. */
import fs from "node:fs";

import { errorMessage } from "../runtime/error-message";
import { unmanagedClaudeDelivery } from "../runtime/claude-delivery-plan";
import { FRAMEWORK_NAME } from "../runtime/framework";
import { PROJECTED_FLAG } from "../runtime/projected-flag";
import { runtimeDirectoryPath, runtimeMateBin } from "../runtime/runtime-directory";
import {
  PREPARE_TIMEOUT_MS,
  spawnPrepareRunner,
  startDetachedPrepareSync,
  type PrepareRun,
  type PrepareRunner,
} from "../runtime/session-prepare-runner";
import { resolveSession } from "../runtime/session-resolution";
import { instructionHookPayload, type InstructionHookDeps } from "./companion-instructions";
import { hookOutcome, runHook, type HookCall, type HookEnv, type HookOutcome } from "./hook-io";

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
    return { ok: false, notes: [errorMessage(error)] };
  }
}

/** The local phase's notes, and the Git sync it leaves for the caller to start. */
interface Prepared {
  notes: string[];
  startSync: () => void;
}

const NO_SYNC = (): void => {};

/**
 * Inert unless the session resolves from a trusted projection, and where the
 * plan gives it nothing to own.
 * Awaits the local phase within a bound, then starts Git sync detached. Always
 * exits zero: a failed prepare must not block the session.
 */
export async function runSessionPrepareHook(
  env: HookEnv,
  cwd: string = process.cwd(),
  deps: SessionPrepareHookDeps = sessionPrepareHookDeps,
): Promise<HookOutcome> {
  const prepared = await guardedPrepare(env, cwd, deps);
  return operatorMessage([...prepared.notes, ...startSync(prepared)]);
}

/** The folder the prepare runs in, and the main thread's instructions are read from. */
function prepareDirectory(env: HookEnv, cwd: string): string {
  return env.CLAUDE_PROJECT_DIR || cwd;
}

function prepareFailure(error: unknown): string {
  return `${FRAMEWORK_NAME}: session prepare failed: ${errorMessage(error)}`;
}

/** A prepare that throws becomes a note, so the instructions after it still go out. */
async function guardedPrepare(
  env: HookEnv,
  cwd: string,
  deps: SessionPrepareHookDeps,
): Promise<Prepared> {
  try {
    return await prepare(env, cwd, deps);
  } catch (error) {
    return { notes: [prepareFailure(error)], startSync: NO_SYNC };
  }
}

/** A sync that fails to start becomes a note. */
function startSync(prepared: Prepared): string[] {
  try {
    prepared.startSync();
    return [];
  } catch (error) {
    return [prepareFailure(error)];
  }
}

async function prepare(env: HookEnv, cwd: string, deps: SessionPrepareHookDeps): Promise<Prepared> {
  const nothing = { notes: [], startSync: NO_SYNC };
  const projectDir = prepareDirectory(env, cwd);
  const session = resolveSession(env, projectDir);
  if (session.kind !== "projection") return nothing;
  const plan = unmanagedClaudeDelivery(session.projection.repoRoot);
  const reconciles = plan.reconcile === "prepare-hook";
  const syncs = plan.gitSync === "prepare-hook";
  if (!reconciles && !syncs) return nothing;

  const mateBin = deps.mateBin();
  if (!mateBin) {
    return {
      notes: [
        `${FRAMEWORK_NAME}: session prepare skipped: ${runtimeDirectoryPath()} is missing; run \`${FRAMEWORK_NAME}\` once to repair it.`,
      ],
      startSync: NO_SYNC,
    };
  }

  const local = reconciles
    ? await runLocalPhase(deps, mateBin, projectDir)
    : { ok: true, notes: [] };
  const verdict = local.ok ? "warning" : "failed";
  return {
    notes: local.notes.map((note) => `${FRAMEWORK_NAME}: session prepare ${verdict}: ${note}`),
    startSync: syncs ? () => deps.startSync(mateBin, projectDir) : NO_SYNC,
  };
}

/**
 * Legacy rule: wraps before `--projected` registered this copy bare, and only
 * this hook re-wraps them. So a bare copy counts as the wrap's unless
 * `CLAUDE_PLUGIN_ROOT`, set for plugin hooks only, marks it as the plugin's.
 */
function isWrapCopy({ argv, env }: HookCall): boolean {
  return argv.includes(PROJECTED_FLAG) || !env.CLAUDE_PLUGIN_ROOT;
}

/**
 * The prepare, the main thread's Companion Instructions, then the Git sync, in
 * one hook: Claude Code runs an event's hooks in parallel, and the prepare and
 * a fast-forward both rewrite the files the instructions are read from. Only
 * the wrap's copy runs any. Input that is not a JSON object is no event.
 */
export async function runSessionStartHook(
  call: HookCall,
  deps: SessionPrepareHookDeps = sessionPrepareHookDeps,
): Promise<HookOutcome> {
  const { env, cwd, input } = call;
  if (!input || typeof input !== "object" || Array.isArray(input)) return hookOutcome(null);
  if (!isWrapCopy(call)) return hookOutcome(null);
  const prepared = await guardedPrepare(env, cwd, deps);
  const { hookSpecificOutput, systemMessage } =
    instructionHookPayload(
      { env, cwd, input, projected: true, directory: prepareDirectory(env, cwd) },
      deps.instructions,
    ) ?? {};
  const notes = [...prepared.notes, ...startSync(prepared)];
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
      operatorMessage([`${FRAMEWORK_NAME}: session start hook failed: ${errorMessage(error)}`]),
  );
}
