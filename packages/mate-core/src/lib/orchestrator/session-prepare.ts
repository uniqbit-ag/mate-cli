import { getActiveDistribution } from "../../distribution";
import { FRAMEWORK_NAME } from "../../framework";
import { launchPassesClaudePluginFolders } from "../../runtime/claude-delivery-plan";
import { recordCompanionSyncUnfinished } from "../../runtime/companion-git-state";
import { withCompanionLock, type CompanionLockOptions } from "../../runtime/companion-lock";
import {
  launchRecoveryStalenessLines,
  syncCompanionUnattended,
  type UnattendedSyncOutcome,
} from "../../runtime/companion-sync";
import type { SessionKind } from "../../runtime/session-kind";
import type { WrapState } from "../../runtime/wrap-state";
import { syncCompanionFiles } from "../../tools/setup";
import type { CapabilityPlugin, LaunchPreflightContext } from "../../tools/setup/plugin";
import type { ClaudePluginFolders } from "../../tools/setup/providers/claude-plugin-folders";
import { attendedLockOptions, syncCompanionGit } from "./companion-git-sync";
import { readCompanionConfig } from "./config-store";
import { entryFailureMessage, firstFailure, type ProjectionChangedPaths } from "./projection-types";
import { LaunchPreflightError, type FrameworkConfig, type LinkedRepository } from "./types";
import { project, projectWorkingRepositoryBestEffort } from "./working-repo-projection";
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
  /** The runtimes a `working-target` or `preflight` step answered for. */
  runtimes?: PrepareRuntime[];
}

export interface PrepareResult {
  /** False when a step failed; warnings alone keep it true. */
  ok: boolean;
  mode: PrepareMode;
  runtime: PrepareRuntime;
  /** Every runtime this prepare reconciled and preflighted. */
  runtimes: PrepareRuntime[];
  repositoryId?: string;
  companionPath: string;
  steps: PrepareStep[];
  warnings: string[];
  /** The sync fast-forwarded the companion. */
  companionChanged?: true;
  /** The first failed step's own error, for an attended caller to raise as it was. */
  failure?: unknown;
  /** The wrap state the `working-target` step's pass left; a launch reads no manifest itself. */
  wrapState?: WrapState;
  /** The Claude plugin folders the `file-sync` step gathered; a launch gathers none itself. */
  claudePluginDirectories?: string[];
}

export interface PrepareSessionInput {
  runtime: PrepareRuntime;
  /**
   * `local`/`sync`: the runtimes the repository is wrapped for, reconciled in
   * one wrap pass and preflighted each; `[runtime]` when absent.
   */
  runtimes?: readonly PrepareRuntime[];
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
  runWrapPass,
  runCapabilityPreflight,
  withCompanionLock,
  /** As the launch decides it: Git may prompt only with a terminal on both ends. */
  isInteractiveTerminal: () => !!(process.stdin.isTTY && process.stdout.isTTY),
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One prepare's running record; `failed` stops an attended prepare. */
class StepLog {
  readonly steps: PrepareStep[] = [];
  readonly warnings: string[] = [];
  failure: unknown;
  wrapState: WrapState | undefined;
  claudePluginDirectories: string[] | undefined;
  stopped = false;
  companionChanged = false;

  constructor(private readonly attended: boolean) {}

  push(step: PrepareStep): void {
    this.steps.push(step);
  }

  fail(
    step: PrepareStepName,
    error: unknown,
    overrides: Pick<PrepareStep, "detail" | "runtimes"> = {},
  ): void {
    this.steps.push({ step, outcome: "failed", detail: message(error), ...overrides });
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
    const folders = input.repository
      ? await deps.syncCompanionFiles(input.companionPath, config, input.repository.path)
      : await deps.syncCompanionFiles(input.companionPath, config);
    run.claudePluginDirectories = [...folders.launch];
    /**
     * The Claude plan speaks for Claude sessions only; OpenCode loads no plugin
     * folder. With a Working Repository the wrap pass reports publication;
     * without one no wrap pass runs, so this step does.
     */
    if (reportsClaudePluginFolders(input)) {
      run.warnings.push(...folders.loadWarnings);
      if (!input.repository) run.warnings.push(...publicationWarnings(folders));
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

/** A managed Claude launch; plain sessions' prepares and OpenCode report no plugin-folder problem. */
function reportsClaudePluginFolders(input: PrepareSessionInput): boolean {
  return input.runtime === "claude" && launchPassesClaudePluginFolders(sessionKindOf(input));
}

/** What a publication left undone, one sentence per folder. */
function publicationWarnings(folders: ClaudePluginFolders | undefined): string[] {
  const publication = folders?.publication;
  if (!publication) return [];
  return [...publication.unpublished.map((entry) => entry.warning), ...publication.warnings];
}

/** Attended is a managed launch, with or without a Working Repository; the rest serve plain sessions. */
function sessionKindOf(input: PrepareSessionInput): SessionKind {
  if (input.mode !== "attended") return "unmanaged";
  return input.repository ? "managed-repo" : "managed-companion";
}

function runtimesOf(input: PrepareSessionInput): PrepareRuntime[] {
  return input.mode !== "attended" && input.runtimes?.length
    ? [...input.runtimes]
    : [input.runtime];
}

/**
 * One wrap pass for `runtimes`, OpenCode's copies included. Every managed
 * launch is this pass followed by the agent, for either runtime.
 */
async function reconcileWrap(
  input: PrepareSessionInput,
  repository: LinkedRepository,
  runtimes: PrepareRuntime[],
  config: FrameworkConfig,
  run: StepLog,
): Promise<void> {
  const wrapped = await sessionPrepareDeps.runWrapPass(input.companionPath, repository, {
    runtimes,
    config,
  });
  if (wrapped.kind === "failed") {
    run.fail("working-target", new LaunchPreflightError(wrapped.message), { runtimes });
    return;
  }
  run.warnings.push(...wrapped.warnings);
  if (reportsClaudePluginFolders(input)) {
    run.warnings.push(...publicationWarnings(wrapped.claudePluginFolders));
  }
  run.wrapState = wrapped.wrapState;
  run.push({
    step: "working-target",
    outcome: "ok",
    detail: wrapped.kind === "written" ? wrapDetail(wrapped) : "current",
    runtimes,
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
    run.fail("launch-projection", new LaunchPreflightError(`${FRAMEWORK_NAME}: ${detail}`), {
      detail,
    });
    return;
  }
  run.push({ step: "launch-projection", outcome: "ok" });
  await deps.refreshProjectionRoot(input.companionPath, repository);
  /** A launch is a wrap: created when missing, reconciled when stale, so the launch can defer to it. */
  await reconcileWrap(input, repository, ["claude"], config, run);
}

/** Attended: the launch's own runtime. Otherwise one wrap pass for every wrapped runtime. */
async function projectRepository(
  input: PrepareSessionInput,
  repository: LinkedRepository,
  runtimes: PrepareRuntime[],
  config: FrameworkConfig,
  run: StepLog,
): Promise<void> {
  if (input.mode === "attended" && input.runtime === "claude") {
    await projectClaude(input, repository, config, run);
    return;
  }
  await reconcileWrap(input, repository, runtimes, config, run);
}

/** File sync, one projection pass, and the capability preflight per runtime. */
async function runLocal(
  input: PrepareSessionInput,
  config: FrameworkConfig,
  run: StepLog,
): Promise<void> {
  await runFileSync(input, config, run);
  if (run.stopped) return;

  const runtimes = runtimesOf(input);
  if (input.repository) {
    await projectRepository(input, input.repository, runtimes, config, run);
    if (run.stopped) return;
  }

  /** Attended prepares one runtime, so running these together never skips a stop. */
  const outcomes = await Promise.allSettled(
    runtimes.map((runtime) =>
      sessionPrepareDeps.runCapabilityPreflight({
        companionPath: input.companionPath,
        config,
        repository: input.repository,
        providerId: runtime,
        sessionKind: sessionKindOf(input),
      }),
    ),
  );
  outcomes.forEach((outcome, index) => {
    const answered = [runtimes[index]!];
    if (outcome.status === "fulfilled") {
      run.push({ step: "preflight", outcome: "ok", runtimes: answered });
    } else {
      run.fail("preflight", outcome.reason, { runtimes: answered });
    }
  });
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
    run.warnings.push(...launchRecoveryStalenessLines(outcome, runtimesOf(input)));
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
    runtimes: runtimesOf(input),
    ...(input.repository ? { repositoryId: input.repository.id } : {}),
    companionPath: input.companionPath,
    steps: run.steps,
    warnings: run.warnings,
    ...(run.companionChanged ? { companionChanged: true as const } : {}),
    ...(run.failure === undefined ? {} : { failure: run.failure }),
    ...(run.wrapState ? { wrapState: run.wrapState } : {}),
    ...(run.claudePluginDirectories
      ? { claudePluginDirectories: run.claudePluginDirectories }
      : {}),
  });

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
