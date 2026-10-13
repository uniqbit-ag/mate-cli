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

const INERT: SessionPrepareHookOutcome = { exitCode: 0, stdout: "" };

/** `systemMessage` only: the model must never be told to repair the companion. */
function operatorMessage(lines: string[]): SessionPrepareHookOutcome {
  if (lines.length === 0) return INERT;
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
  if (hasLaunchEnvironment(env)) return INERT;
  const projectDir = env.CLAUDE_PROJECT_DIR || cwd;
  const projection = resolveProjection(projectDir);
  if (!projection) return INERT;
  const plan = unmanagedClaudeDelivery(projection.repoRoot);
  const reconciles = plan.reconcile === "prepare-hook";
  const syncs = plan.gitSync === "prepare-hook";
  if (!reconciles && !syncs) return INERT;

  const mateBin = deps.mateBin();
  if (!mateBin) {
    return operatorMessage([
      `mate: session prepare skipped: ${runtimeDirectoryPath()} is missing; run \`mate\` once to repair it.`,
    ]);
  }

  const local = reconciles
    ? await runLocalPhase(deps, mateBin, projectDir)
    : { ok: true, notes: [] };
  if (syncs) deps.startSync(mateBin, projectDir);

  const verdict = local.ok ? "warning" : "failed";
  return operatorMessage(local.notes.map((note) => `mate: session prepare ${verdict}: ${note}`));
}

/** Plugin-shim entry. */
export async function run(): Promise<number> {
  const outcome = await runSessionPrepareHook(process.env);
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  return outcome.exitCode;
}
