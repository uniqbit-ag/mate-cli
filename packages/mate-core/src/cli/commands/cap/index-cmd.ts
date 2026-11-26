import { hasTokensaveCapability } from "../../../lib/orchestrator/capabilities";
import { resolveForCapability } from "../../../lib/orchestrator/framework-context";
import { resolveSecretPolicy } from "../../../runtime/policy";
import { tokensaveCheckout } from "../../../runtime/tokensave-route";
import type { CapabilityConfig } from "../../../lib/orchestrator/types";
import {
  ensureTokensaveBranchingPosture,
  ensureTokensaveStoreExcluded,
  isTokensaveIndexed,
} from "../../../tools/setup/capabilities/tokensave";
import {
  createStartupProgress,
  type StartupProgressController,
} from "../../../lib/components/startup-progress";
import { ensureUnambiguousCompanion } from "../shared/companion-selection";
import { runTokensaveCapCommand } from "./tokensave";

type CapRunner = (args: string[]) => Promise<void>;

export type SyncCapStep = "tokensave";

export interface SyncCapDeps {
  ensureUnambiguousCompanion?: (cwd: string) => Promise<boolean>;
  loadCapabilities?: () => Promise<CapabilityConfig[]>;
  /** The resolved Working Repository's path, if any. */
  resolveRepositoryPath?: () => Promise<string | undefined>;
  cwd?: () => string;
  isTokensaveInitialized?: (repoPath: string) => Promise<boolean>;
  ensureTokensaveStoreExcluded?: (repoPath: string) => Promise<void>;
  ensureTokensaveBranchingPosture?: (repoPath: string) => Promise<void>;
  runTokensave?: CapRunner;
  /** Replace the default hand-over lines; launch passes its own progress screen. */
  onStepStart?: (step: SyncCapStep) => void;
  onStepDone?: (step: SyncCapStep, ok: boolean) => void;
  createProgress?: typeof createStartupProgress;
}

const STEP_LABELS: Record<SyncCapStep, string> = {
  tokensave: "Syncing tokensave",
};

/** The companion's live secret policy decides the secret-file excludes. */
async function defaultEnsureBranchingPosture(repoPath: string): Promise<void> {
  const { companionPath } = await resolveForCapability(process.cwd());
  await ensureTokensaveBranchingPosture(repoPath, resolveSecretPolicy(companionPath));
}

async function defaultLoadCapabilities(): Promise<CapabilityConfig[]> {
  const { configStore } = await resolveForCapability(process.cwd());
  const config = await configStore.load();
  return config.capabilities ?? [];
}

async function defaultResolveRepositoryPath(): Promise<string | undefined> {
  const { repositoryId, repository, workingRepoStore } = await resolveForCapability(process.cwd());
  const repo =
    repository ?? (await workingRepoStore.load()).repos.find((entry) => entry.id === repositoryId);
  return repo?.path;
}

// The reused cap command (runTokensaveCapCommand) signals
// success/failure ONLY by mutating process.exitCode — they never return a value and
// never throw on a non-zero child status (a successful child sets it to 0). Baseline
// to 0 first so we read this step's result in isolation, then clear it back to 0 so a
// prior failure can't leak into the next step's read or be mistaken for the aggregate
// we set at the end. Note: `process.exitCode = undefined` does NOT reset it under Bun
// (the runtime mate ships on) — it retains the previous value — so 0 is used, not
// undefined. If the reused command's error-signaling convention ever changes, this
// gating stops working — see index-cmd.test.ts.
async function runCapStep(run: () => Promise<void>): Promise<boolean> {
  process.exitCode = 0;
  await run();
  const code = process.exitCode;
  process.exitCode = 0;
  return code === 0;
}

function parseSyncOptions(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--tokensave") continue;
    process.stderr.write(`mate: unknown sync option: ${arg}\n`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

/**
 * @command mate cap index [--tokensave]
 * @description Re-syncs the tokensave index after source changes. When
 * `tokensave` is enabled, initializes it on first run (`tokensave init`) or
 * otherwise runs `tokensave sync`.
 * @flags
 * - `--tokensave` — accepted for compatibility; tokensave is the only step.
 * @remarks Exits non-zero if the tokensave step fails.
 */
export async function runIndexCapCommand(args: string[], deps: SyncCapDeps = {}): Promise<void> {
  if (!parseSyncOptions(args)) return;

  const loadCapabilities = deps.loadCapabilities ?? defaultLoadCapabilities;
  const ensureCompanion = deps.ensureUnambiguousCompanion ?? ensureUnambiguousCompanion;

  if (!(await ensureCompanion(process.cwd()))) {
    process.exitCode = 1;
    return;
  }

  const capabilities = await loadCapabilities();

  // tokensave writes straight to the terminal: a labelled hand-over, no spinner.
  let progress: StartupProgressController | undefined;
  const onStepStart =
    deps.onStepStart ??
    ((step: SyncCapStep) => {
      progress ??= (deps.createProgress ?? createStartupProgress)("Indexing capabilities");
      progress.handOver(step, STEP_LABELS[step]);
    });
  const onStepDone =
    deps.onStepDone ??
    ((step: SyncCapStep, ok: boolean) => {
      if (ok) progress?.succeed(step);
      else progress?.fail(step);
    });

  try {
    await runSteps(capabilities, { onStepStart, onStepDone }, deps);
  } finally {
    progress?.stop();
  }
}

async function runSteps(
  capabilities: CapabilityConfig[],
  { onStepStart, onStepDone }: Required<Pick<SyncCapDeps, "onStepStart" | "onStepDone">>,
  deps: SyncCapDeps,
): Promise<void> {
  const resolveRepositoryPath = deps.resolveRepositoryPath ?? defaultResolveRepositoryPath;
  const cwd = deps.cwd ?? (() => process.cwd());
  const isTokensaveInitialized = deps.isTokensaveInitialized ?? isTokensaveIndexed;
  const ensureStoreExcluded = deps.ensureTokensaveStoreExcluded ?? ensureTokensaveStoreExcluded;
  const ensureBranchingPosture =
    deps.ensureTokensaveBranchingPosture ?? defaultEnsureBranchingPosture;
  const runTokensave = deps.runTokensave ?? runTokensaveCapCommand;
  let failed = false;

  if (hasTokensaveCapability(capabilities)) {
    onStepStart("tokensave");
    /** One checkout for check, init, posture and sync; `runTokensave` resolves the same one. */
    const resolved = await resolveRepositoryPath();
    const repoPath = resolved ? tokensaveCheckout(cwd(), resolved) : null;
    if (!repoPath) {
      // Never the raw cwd: it may be a subfolder, and `runTokensave` would refuse anyway.
      process.stderr.write("mate cap index: no working repository resolved for tokensave\n");
      failed = true;
      onStepDone("tokensave", false);
    } else if (!(await isTokensaveInitialized(repoPath))) {
      await ensureStoreExcluded(repoPath);
      const initOk = await runCapStep(() => runTokensave(["init", "--no-git-hook"]));
      if (!initOk) {
        failed = true;
        onStepDone("tokensave", false);
      } else {
        /** The store config only exists once `tokensave init` has created it. */
        await ensureBranchingPosture(repoPath);
        const syncOk = await runCapStep(() => runTokensave(["sync"]));
        if (!syncOk) failed = true;
        onStepDone("tokensave", syncOk);
      }
    } else {
      await ensureBranchingPosture(repoPath);
      const syncOk = await runCapStep(() => runTokensave(["sync"]));
      if (!syncOk) failed = true;
      onStepDone("tokensave", syncOk);
    }
  }

  if (failed) process.exitCode = 1;
}
