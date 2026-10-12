import { getActiveDistribution } from "../../distribution";
import { FRAMEWORK_NAME } from "../../framework";
import { recordCompanionSyncUnfinished } from "../../runtime/companion-git-state";
import { withCompanionLock, type CompanionLockOptions } from "../../runtime/companion-lock";
import {
  syncCompanionUnattended,
  unattendedSyncStalenessLines,
  type UnattendedSyncOutcome,
} from "../../runtime/companion-sync";
import { syncCompanionFiles } from "../../tools/setup";
import type { CapabilityPlugin, LaunchPreflightContext } from "../../tools/setup/plugin";
import { attendedLockOptions, syncCompanionGit } from "./companion-git-sync";
import { readCompanionConfig } from "./config-store";
import { entryFailureMessage, firstFailure, type ProjectionChangedPaths } from "./projection-types";
import { LaunchPreflightError, type FrameworkConfig, type LinkedRepository } from "./types";
import {
  isWorkingRepositoryWrapped,
  project,
  projectWorkingRepositoryBestEffort,
} from "./working-repo-projection";
import { runWrapPass } from "./wrap-pass";

/**
 * Session Prepare: Git sync, file sync, one projection pass, preflight. Never
 * spawns a runtime.
 * - `attended`: managed launch; waits for the lock, stops at first failure.
 * - `local`: plugin's awaited phase; no remote, only tries the lock.
 * - `sync`: plugin's detached fast-forward, then `local` if the companion moved.
 */

export type PrepareMode = "attended" | "local" | "sync";
export type PrepareRuntime = "claude" | "opencode";

export type PrepareStepName =
  | "refusal"
  | "lock"
  | "git-sync"
  | "file-sync"
  | "launch-projection"
  | "working-target"
  | "preflight";

export interface PrepareStep {
  step: PrepareStepName;
  outcome: "ok" | "skipped" | "warning" | "failed";
  detail?: string;
}

export interface PrepareResult {
  /** False when a step failed; warnings alone keep it true. */
  ok: boolean;
  mode: PrepareMode;
  runtime: PrepareRuntime;
  repositoryId?: string;
  companionPath: string;
  steps: PrepareStep[];
  warnings: string[];
  /** The sync fast-forwarded the companion. */
  companionChanged?: true;
  /** The first failed step's own error, for an attended caller to raise as it was. */
  failure?: unknown;
}

export interface PrepareSessionInput {
  runtime: PrepareRuntime;
  companionPath: string;
  /** Absent for a companion-scope launch: nothing is projected. */
  repository?: LinkedRepository;
  mode: PrepareMode;
  /** The companion config the caller already holds; read once here otherwise. */
  config?: FrameworkConfig;
  /** `--no-git`: an attended prepare skips only the Git sync. */
  skipGit?: boolean;
}

/** The detached sync may queue behind an operator answering a merge conflict. */
const SYNC_LOCK_TIMEOUT_MS = 5 * 60_000;

/**
 * Every enabled Capability's preflight for one runtime, run together. Throws a
 * {@link LaunchPreflightError} listing what failed.
 */
async function runCapabilityPreflight(context: LaunchPreflightContext): Promise<void> {
  const { config, providerId } = context;
  const preflights = getActiveDistribution()
    .registry.getAll()
    .flatMap((plugin) => {
      if (plugin.kind !== "capability" || !plugin.isEnabled(config)) return [];
      const capability = plugin as CapabilityPlugin;
      const preflight = capability.forProvider?.[providerId]?.preflight;
      return preflight ? [{ capability, preflight }] : [];
    });
  const results = await Promise.all(
    preflights.map(async ({ capability, preflight }) => {
      try {
        return await preflight(context);
      } catch (error) {
        throw new LaunchPreflightError(
          `Capability preflight failed for ${capability.id} on ${providerId}: ${message(error)}`,
          { cause: error },
        );
      }
    }),
  );
  const diagnostics = results.flat();

  if (diagnostics.length > 0) {
    throw new LaunchPreflightError(
      ["Capability launch preflight failed.", ...diagnostics.map((item) => `- ${item}`)].join("\n"),
    );
  }
}

export const sessionPrepareDeps = {
  readCompanionConfig,
  syncCompanionGit,
  syncCompanionUnattended,
  recordCompanionSyncUnfinished,
  syncCompanionFiles,
  projectLaunch: (input: Parameters<typeof project>[1]) => project("launch", input),
  /**
   * The Projection Root a Claude launch guarantees for itself. Companion
   * resolution also writes it, but only on the branch that resolved a companion
   * from the Working Repository; asking here makes the guarantee independent of
   * which branch answered. Best-effort — a launch carries its own configuration.
   */
  refreshProjectionRoot: projectWorkingRepositoryBestEffort,
  isWrapped: isWorkingRepositoryWrapped,
  runWrapPass,
  runCapabilityPreflight,
  withCompanionLock,
  /** As the launch decides it: Git may prompt only with a terminal on both ends. */
  isInteractiveTerminal: () => !!(process.stdin.isTTY && process.stdout.isTTY),
};

/**
 * A managed Claude launch in a Claude-wrapped repo would load the companion
 * twice (wrapped documents plus launch flags), so it is refused before any
 * write, the lock included. OpenCode's managed launch is itself a wrap.
 */
function wrappedRepositoryRefusal(repository: LinkedRepository): string {
  return [
    `${FRAMEWORK_NAME}: ${repository.id} is wrapped for Claude — \`${FRAMEWORK_NAME} claude\` does not run in a Claude-wrapped working repository.`,
    "Start the session yourself: `claude` — the wrap delivers the companion guidance.",
    `Or restore managed launches: \`${FRAMEWORK_NAME} unwrap\`.`,
  ].join("\n");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One prepare's running record; `failed` stops an attended prepare. */
class StepLog {
  readonly steps: PrepareStep[] = [];
  readonly warnings: string[] = [];
  failure: unknown;
  stopped = false;
  companionChanged = false;

  constructor(private readonly attended: boolean) {}

  push(step: PrepareStep): void {
    this.steps.push(step);
  }

  fail(step: PrepareStepName, error: unknown, detail = message(error)): void {
    this.steps.push({ step, outcome: "failed", detail });
    if (this.failure === undefined) this.failure = error;
    if (this.attended) this.stopped = true;
  }
}

async function runFileSync(
  input: PrepareSessionInput,
  config: FrameworkConfig,
  run: StepLog,
): Promise<void> {
  const deps = sessionPrepareDeps;
  try {
    if (input.repository) {
      await deps.syncCompanionFiles(input.companionPath, config, input.repository.path);
    } else {
      await deps.syncCompanionFiles(input.companionPath, config);
    }
    run.push({ step: "file-sync", outcome: "ok" });
  } catch (error) {
    run.fail("file-sync", error);
  }
}

function wrapDetail(wrapped: {
  writtenDocuments: string[];
  changed: ProjectionChangedPaths;
}): string {
  const wrote = [...wrapped.writtenDocuments, ...wrapped.changed.written];
  const withdrew = wrapped.changed.removed;
  const parts: string[] = [];
  if (wrote.length > 0) parts.push(`wrote ${wrote.join(", ")}`);
  if (withdrew.length > 0) parts.push(`withdrew ${withdrew.join(", ")}`);
  return parts.length > 0 ? `updated (${parts.join("; ")})` : "updated";
}

/** OpenCode: the wrap pass alone, its copies included — the managed launch is a wrap. */
async function projectOpenCode(
  input: PrepareSessionInput,
  repository: LinkedRepository,
  config: FrameworkConfig,
  run: StepLog,
): Promise<void> {
  const wrapped = await sessionPrepareDeps.runWrapPass(input.companionPath, repository, {
    runtimes: ["opencode"],
    config,
  });
  if (wrapped.kind === "failed") {
    run.fail("working-target", new LaunchPreflightError(wrapped.message), wrapped.message);
    return;
  }
  run.warnings.push(...wrapped.warnings);
  run.push({
    step: "working-target",
    outcome: "ok",
    detail: wrapped.kind === "written" ? wrapDetail(wrapped) : "current",
  });
}

/**
 * Claude: the launch scope, then the Projection Root. A non-degradable entry is
 * a guardrail the session was promised, so it fails the prepare; a degradable
 * one warns and the prepare proceeds.
 */
async function projectClaude(
  input: PrepareSessionInput,
  repository: LinkedRepository,
  config: FrameworkConfig,
  run: StepLog,
): Promise<void> {
  const deps = sessionPrepareDeps;
  const result = await deps.projectLaunch({
    repoPath: repository.path,
    companionPath: input.companionPath,
    config,
  });
  for (const outcome of result.outcomes) {
    if (outcome.state === "failed" && outcome.degradable) {
      run.warnings.push(entryFailureMessage(outcome, repository.id));
    }
  }
  const failure = firstFailure(result.outcomes);
  if (failure) {
    const detail = entryFailureMessage(failure, repository.id);
    run.fail("launch-projection", new LaunchPreflightError(`${FRAMEWORK_NAME}: ${detail}`), detail);
    return;
  }
  run.push({ step: "launch-projection", outcome: "ok" });
  await deps.refreshProjectionRoot(input.companionPath, repository);
}

/** File sync, one projection pass for the runtime, and the capability preflight. */
async function runLocal(
  input: PrepareSessionInput,
  config: FrameworkConfig,
  run: StepLog,
): Promise<void> {
  await runFileSync(input, config, run);
  if (run.stopped) return;

  if (input.repository) {
    await (input.runtime === "opencode" ? projectOpenCode : projectClaude)(
      input,
      input.repository,
      config,
      run,
    );
    if (run.stopped) return;
  }

  try {
    await sessionPrepareDeps.runCapabilityPreflight({
      companionPath: input.companionPath,
      config,
      repository: input.repository,
      providerId: input.runtime,
    });
    run.push({ step: "preflight", outcome: "ok" });
  } catch (error) {
    run.fail("preflight", error);
  }
}

async function runAttended(
  input: PrepareSessionInput,
  config: FrameworkConfig,
  run: StepLog,
): Promise<void> {
  const deps = sessionPrepareDeps;
  if (input.skipGit) {
    run.push({ step: "git-sync", outcome: "skipped", detail: "--no-git" });
  } else if (config.git !== "auto") {
    run.push({ step: "git-sync", outcome: "skipped", detail: "companion Git mode is not auto" });
  } else {
    try {
      const synced = await deps.syncCompanionGit(
        input.companionPath,
        input.repository?.path,
        deps.isInteractiveTerminal(),
      );
      run.push({ step: "git-sync", outcome: "ok" });
      /** A pull may have changed the companion's own selection. */
      if (synced?.changed) config = await deps.readCompanionConfig(input.companionPath);
    } catch (error) {
      run.fail("git-sync", error);
      return;
    }
  }
  await runLocal(input, config, run);
}

/** The sync's own config read: only a fast-forward can have changed it. */
async function runSync(input: PrepareSessionInput, run: StepLog): Promise<void> {
  const deps = sessionPrepareDeps;
  let outcome: UnattendedSyncOutcome;
  try {
    outcome = await deps.syncCompanionUnattended(input.companionPath, { ttlMs: 0 });
  } catch (error) {
    const reason = message(error);
    /** Persisted like any unfinished sync, so the TUI's session lines carry it. */
    deps.recordCompanionSyncUnfinished(input.companionPath, reason);
    outcome = { status: "unfinished", changed: false, companionPath: input.companionPath, reason };
  }

  if (outcome.status === "unfinished") {
    run.push({ step: "git-sync", outcome: "warning", detail: outcome.reason });
    run.warnings.push(...unattendedSyncStalenessLines(outcome, input.runtime));
    return;
  }
  if (outcome.status !== "complete") {
    run.push({ step: "git-sync", outcome: "skipped", detail: outcome.status });
    return;
  }
  if (!outcome.changed) {
    run.push({ step: "git-sync", outcome: "ok", detail: "current" });
    return;
  }
  run.push({ step: "git-sync", outcome: "ok", detail: "fast-forwarded" });
  run.companionChanged = true;
  await runLocal(input, await deps.readCompanionConfig(input.companionPath), run);
}

function lockOptions(input: PrepareSessionInput): CompanionLockOptions {
  if (input.mode === "attended") return attendedLockOptions(input.companionPath);
  if (input.mode === "local") return { wait: false };
  return { timeoutMs: SYNC_LOCK_TIMEOUT_MS };
}

export async function prepareSession(input: PrepareSessionInput): Promise<PrepareResult> {
  const deps = sessionPrepareDeps;
  const run = new StepLog(input.mode === "attended");
  const result = (): PrepareResult => ({
    ok: !run.steps.some((step) => step.outcome === "failed"),
    mode: input.mode,
    runtime: input.runtime,
    ...(input.repository ? { repositoryId: input.repository.id } : {}),
    companionPath: input.companionPath,
    steps: run.steps,
    warnings: run.warnings,
    ...(run.companionChanged ? { companionChanged: true as const } : {}),
    ...(run.failure === undefined ? {} : { failure: run.failure }),
  });

  if (
    input.mode === "attended" &&
    input.runtime === "claude" &&
    input.repository &&
    (await deps.isWrapped(input.repository.path, "claude"))
  ) {
    const refusal = wrappedRepositoryRefusal(input.repository);
    run.fail("refusal", new LaunchPreflightError(refusal), refusal);
    return result();
  }

  const locked = await deps.withCompanionLock(input.companionPath, lockOptions(input), async () => {
    if (input.mode === "sync") return runSync(input, run);
    const config = input.config ?? (await deps.readCompanionConfig(input.companionPath));
    return input.mode === "attended"
      ? runAttended(input, config, run)
      : runLocal(input, config, run);
  });

  if (!locked.acquired) {
    if (input.mode === "local") {
      /** Another prepare is on it; the projection already in place serves the session. */
      run.push({ step: "lock", outcome: "skipped", detail: "another prepare holds the companion" });
    } else {
      const detail = "another companion sync did not finish in time; skipped";
      run.push({ step: "lock", outcome: "warning", detail });
      run.warnings.push(detail);
    }
  }
  return result();
}
