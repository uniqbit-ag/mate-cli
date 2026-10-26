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
import { instructionHookPayload, readHookInput } from "./companion-instructions";
import type { HookEnv } from "./validate-artifact-path";

export interface SessionPrepareHookOutcome {
  exitCode: number;
  stdout: string;
}

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
function operatorMessage(lines: string[]): SessionPrepareHookOutcome {
  if (lines.length === 0) return { exitCode: 0, stdout: "" };
  return { exitCode: 0, stdout: `${JSON.stringify({ systemMessage: lines.join("\n") })}\n` };
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
    return { ok: false, notes: [error instanceof Error ? error.message : String(error)] };
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
): Promise<SessionPrepareHookOutcome> {
  return operatorMessage(await prepareNotes(env, cwd, deps));
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
): Promise<SessionPrepareHookOutcome> {
  const notes = await prepareNotes(env, cwd, deps);
  const { hookSpecificOutput, systemMessage } = instructionHookPayload(env, cwd, argv, input) ?? {};
  const messages = systemMessage ? [...notes, systemMessage] : notes;
  if (!hookSpecificOutput) return operatorMessage(messages);
  const output = {
    hookSpecificOutput,
    ...(messages.length > 0 ? { systemMessage: messages.join("\n") } : {}),
  };
  return { exitCode: 0, stdout: `${JSON.stringify(output)}\n` };
}

/** Plugin-shim entry. Ignores stdout errors, so a closed pipe cannot crash it with `EPIPE`. */
export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const input = await readHookInput();
  const outcome = await runSessionStartHook(process.env, process.cwd(), argv, input);
  if (outcome.stdout) {
    process.stdout.on("error", () => {});
    process.stdout.write(outcome.stdout);
  }
  return outcome.exitCode;
}
