import {
  hasGraphifyCapability,
  hasTokensaveCapability,
} from "../../../lib/orchestrator/capabilities";
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
import { runGraphifyCapCommand } from "./graphify";
import { runTokensaveCapCommand } from "./tokensave";

type CapRunner = (args: string[]) => Promise<void>;

export type SyncCapStep = "graphify" | "tokensave";

export interface SyncCapDeps {
  ensureUnambiguousCompanion?: (cwd: string) => Promise<boolean>;
  loadCapabilities?: () => Promise<CapabilityConfig[]>;
  /** The resolved Working Repository's path, if any. */
  resolveRepositoryPath?: () => Promise<string | undefined>;
  cwd?: () => string;
  isTokensaveInitialized?: (repoPath: string) => Promise<boolean>;
  ensureTokensaveStoreExcluded?: (repoPath: string) => Promise<void>;
  ensureTokensaveBranchingPosture?: (repoPath: string) => Promise<void>;
  runGraphify?: CapRunner;
  runTokensave?: CapRunner;
  /** Replace the default hand-over lines; launch passes its own progress screen. */
  onStepStart?: (step: SyncCapStep) => void;
  onStepDone?: (step: SyncCapStep, ok: boolean) => void;
  createProgress?: typeof createStartupProgress;
}

const STEP_LABELS: Record<SyncCapStep, string> = {
  graphify: "Syncing graphify",
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

// The reused cap commands (runGraphifyCapCommand / runTokensaveCapCommand) signal
// success/failure ONLY by mutating process.exitCode — they never return a value and
// never throw on a non-zero child status (a successful child sets it to 0). Baseline
// to 0 first so we read this step's result in isolation, then clear it back to 0 so a
// prior failure can't leak into the next step's read or be mistaken for the aggregate
// we set at the end. Note: `process.exitCode = undefined` does NOT reset it under Bun
// (the runtime mate ships on) — it retains the previous value — so 0 is used, not
// undefined. If either reused command's error-signaling convention ever changes, this
// gating stops working — see sync.test.ts.
async function runCapStep(run: () => Promise<void>): Promise<boolean> {
  process.exitCode = 0;
  await run();
  const code = process.exitCode;
  process.exitCode = 0;
  return code === 0;
}

function parseSyncOptions(
  args: string[],
): { includeGraphify: boolean; includeTokensave: boolean } | null {
  let includeGraphify = false;
  let includeTokensave = false;

  for (const arg of args) {
    if (arg === "--graphify") {
      includeGraphify = true;
      continue;
    }

    if (arg === "--tokensave") {
      includeTokensave = true;
      continue;
    }

    process.stderr.write(`mate: unknown sync option: ${arg}\n`);
    process.exitCode = 1;
    return null;
  }

  if (includeGraphify && includeTokensave) {
    process.stderr.write("mate: --graphify and --tokensave cannot be used together\n");
    process.exitCode = 1;
    return null;
  }

  return { includeGraphify, includeTokensave };
}

/**
 * @command mate cap index [--graphify] [--tokensave]
 * @description Re-syncs code-exploration capability indexes after source
 * changes. When the `graphify` capability is enabled and either `--graphify`
 * was passed or `tokensave` is not also enabled, runs
 * `graphify . --update --code-only`. When `tokensave` is enabled (and neither
 * `--graphify` nor `--tokensave` was passed), initializes it on first run (`tokensave init`)
 * or otherwise runs `tokensave sync`; if both capabilities are enabled, graphify
 * is re-run once more afterward so its graph reflects the tokensave-synced state.
 * @flags
 * - `--graphify` — only sync graphify, skipping the tokensave step entirely.
 * - `--tokensave` — only sync tokensave, skipping graphify even when enabled.
 * @remarks Exits non-zero if any invoked step (graphify or tokensave) fails.
 */
export async function runIndexCapCommand(args: string[], deps: SyncCapDeps = {}): Promise<void> {
  const options = parseSyncOptions(args);
  if (!options) {
    return;
  }

  const loadCapabilities = deps.loadCapabilities ?? defaultLoadCapabilities;
  const ensureCompanion = deps.ensureUnambiguousCompanion ?? ensureUnambiguousCompanion;

  if (!(await ensureCompanion(process.cwd()))) {
    process.exitCode = 1;
    return;
  }

  const capabilities = await loadCapabilities();

  // graphify and tokensave write straight to the terminal: labelled hand-overs, no spinner.
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
    await runSteps(options, capabilities, { onStepStart, onStepDone }, deps);
  } finally {
    progress?.stop();
  }
}

async function runSteps(
  options: { includeGraphify: boolean; includeTokensave: boolean },
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
  const runGraphify = deps.runGraphify ?? runGraphifyCapCommand;
  const runTokensave = deps.runTokensave ?? runTokensaveCapCommand;
  let failed = false;

  if (hasGraphifyCapability(capabilities)) {
    if (
      options.includeGraphify ||
      (!options.includeTokensave && !hasTokensaveCapability(capabilities))
    ) {
      onStepStart("graphify");
      const updateOk = await runCapStep(() => runGraphify([".", "--update", "--code-only"]));
      onStepDone("graphify", updateOk);
      if (!updateOk) {
        failed = true;
      }
    }
  }

  if (!options.includeGraphify && hasTokensaveCapability(capabilities)) {
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

  if (
    !options.includeGraphify &&
    !options.includeTokensave &&
    hasGraphifyCapability(capabilities) &&
    hasTokensaveCapability(capabilities)
  ) {
    onStepStart("graphify");
    const updateOk = await runCapStep(() => runGraphify([".", "--update", "--code-only"]));
    onStepDone("graphify", updateOk);
    if (!updateOk) {
      failed = true;
    }
  }

  if (failed) process.exitCode = 1;
}
