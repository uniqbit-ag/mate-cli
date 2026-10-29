/**
 * The unattended half of companion Git synchronization: fetch, then
 * fast-forward when the companion is strictly behind. Everything a human must
 * answer — divergence, a dirty tree, credentials, an in-progress merge — is
 * reported rather than attempted.
 *
 * Lives under `runtime/` because the session-start hooks need it and may not
 * import `lib/orchestrator`.
 */
import fs from "node:fs";
import path from "node:path";

import {
  COMPANION_SYNC_TTL_MS,
  FORK_VERDICT_TTL_MS,
  isCompanionSyncDue,
  readCachedForkRecord,
  readCompanionGitRecord,
  recordCompanionSync,
  recordCompanionSyncUnfinished,
  recordForkVerdict,
} from "./companion-git-state";
import {
  companionForkState,
  companionGit,
  describeGitFailure,
  GIT_QUERY_TIMEOUT_MS,
  isAuthenticationFailure,
  outputLines,
  type CompanionForkState,
  type CompanionGit,
} from "./companion-git";
import { withCompanionLock } from "./companion-lock";
import { FRAMEWORK_NAME } from "./framework";
import { readCompanionPolicy } from "./policy";

/** The one command that finishes what the unattended half declines to do. */
export const COMPANION_SYNC_COMMAND = `${FRAMEWORK_NAME} companion sync`;

/** OpenCode's recovery is the managed launch: it runs the sync at a terminal that can answer Git. */
export const OPENCODE_LAUNCH_COMMAND = `${FRAMEWORK_NAME} opencode`;

/** A Claude-wrapped repository's equivalent: the attended launch reconciles the wrap. */
export const CLAUDE_LAUNCH_COMMAND = `${FRAMEWORK_NAME} claude`;

/** Which runtime's operator reads the note; it decides the recovery named. */
export type StalenessAudience = "claude" | "opencode";

/** A cold link costs this once; the recorded completion then suppresses retries. */
export const COMPANION_SYNC_TIMEOUT_MS = 20_000;

/** `busy`: another operation held the companion lock; nothing ran and nothing is owed. */
export type UnattendedSyncStatus = "not-applicable" | "fresh" | "busy" | "complete" | "unfinished";

export interface UnattendedSyncOutcome {
  status: UnattendedSyncStatus;
  changed: boolean;
  companionPath: string;
  /** Set for `unfinished`: what a human must resolve. */
  reason?: string;
}

export interface UnattendedSyncOptions {
  ttlMs?: number;
  /** The operation's time budget, fallbacks included. */
  timeoutMs?: number;
  now?: Date;
  homeDir?: string;
  /** Environment Git runs with. */
  env?: Record<string, string | undefined>;
  /**
   * `wait` (the default) queues behind another holder of the companion lock,
   * within the time budget; `try` skips at once, for a hook that must not
   * stall a session start.
   */
  lock?: "wait" | "try";
}

const UNFINISHED_GIT_PATHS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
];

async function hasGitPath(
  git: CompanionGit,
  companionPath: string,
  name: string,
): Promise<boolean> {
  const gitPath = await git.run(["rev-parse", "--git-path", name]);
  if (gitPath.status !== 0) return false;
  return fs.existsSync(path.resolve(companionPath, gitPath.stdout.trim()));
}

function notApplicable(companionPath: string): UnattendedSyncOutcome {
  return { status: "not-applicable", changed: false, companionPath };
}

function unfinished(
  companionPath: string,
  reason: string,
  homeDir: string | undefined,
): UnattendedSyncOutcome {
  /** Persisted so a reader that renders session state can surface it without re-running Git. */
  recordCompanionSyncUnfinished(companionPath, reason, homeDir);
  return { status: "unfinished", changed: false, companionPath, reason };
}

/**
 * The consent gate is held here, before any process is spawned, so that
 * reaching this function at all is enough to be safe — no caller can widen the
 * operator's standing answer to "may Mate touch my Git".
 */
export async function syncCompanionUnattended(
  companionPath: string,
  options: UnattendedSyncOptions = {},
): Promise<UnattendedSyncOutcome> {
  const {
    ttlMs = COMPANION_SYNC_TTL_MS,
    timeoutMs = COMPANION_SYNC_TIMEOUT_MS,
    now = new Date(),
    homeDir,
    env,
  } = options;

  if (!companionPath) return notApplicable(companionPath);
  if (!readCompanionPolicy(companionPath).gitAutoMode) return notApplicable(companionPath);
  if (!isCompanionSyncDue(companionPath, ttlMs, now, homeDir)) {
    return { status: "fresh", changed: false, companionPath };
  }

  const locked = await withCompanionLock(
    companionPath,
    { homeDir, wait: options.lock !== "try", timeoutMs },
    () => syncHoldingLock(companionPath, { timeoutMs, now, homeDir, env }),
  );
  return locked.acquired ? locked.value : { status: "busy", changed: false, companionPath };
}

async function syncHoldingLock(
  companionPath: string,
  options: {
    timeoutMs: number;
    now: Date;
    homeDir?: string;
    env?: Record<string, string | undefined>;
  },
): Promise<UnattendedSyncOutcome> {
  const { timeoutMs, now, homeDir, env } = options;
  const git = companionGit(companionPath, {
    prompt: "never",
    budgetMs: timeoutMs,
    commandCapMs: GIT_QUERY_TIMEOUT_MS,
    env,
  });

  const target = await git.upstreamTarget();
  if (!target) return notApplicable(companionPath);

  const present = await Promise.all(
    UNFINISHED_GIT_PATHS.map((name) => hasGitPath(git, companionPath, name)),
  );
  const inProgress = UNFINISHED_GIT_PATHS.filter((_, index) => present[index]);
  if (inProgress.length > 0) {
    return unfinished(
      companionPath,
      `an unfinished Git operation is in progress (${inProgress.join(", ")})`,
      homeDir,
    );
  }

  const fetch = await git.fetch(["--no-progress", target.remote, target.branch]);
  if (fetch.status !== 0) {
    if (isAuthenticationFailure(fetch)) {
      return unfinished(companionPath, `fetching ${target.ref} needs Git authentication`, homeDir);
    }
    return unfinished(
      companionPath,
      `unable to fetch ${target.ref}: ${describeGitFailure(fetch)}`,
      homeDir,
    );
  }

  const fork = await git.forkState(target.ref);
  if (!fork) return notApplicable(companionPath);

  if (fork.behind === 0) {
    recordCompanionSync(companionPath, now, homeDir);
    return { status: "complete", changed: false, companionPath };
  }
  if (fork.ahead > 0) {
    return unfinished(
      companionPath,
      `history has diverged from ${target.ref} (${fork.ahead} ahead, ${fork.behind} behind)`,
      homeDir,
    );
  }

  const merge = await git.run(["merge", "--ff-only", "--no-stat", "--no-progress", target.ref]);
  if (merge.status !== 0) {
    const dirty = await git.run(["status", "--porcelain=v1", "--untracked-files=all"]);
    if (dirty.status === 0 && outputLines(dirty.stdout).length > 0) {
      return unfinished(
        companionPath,
        `local changes block the fast-forward to ${target.ref}`,
        homeDir,
      );
    }
    return unfinished(
      companionPath,
      `unable to fast-forward to ${target.ref}: ${describeGitFailure(merge)}`,
      homeDir,
    );
  }

  recordCompanionSync(companionPath, now, homeDir);
  return { status: "complete", changed: true, companionPath };
}

/**
 * Operator-facing only. This text must never reach a model-visible channel: a
 * model told to run the command will run it unattended, with no terminal to
 * answer a credential prompt and no way to tell a fast-forward from a
 * conflicted rebase.
 */
export function unattendedSyncStalenessLines(
  outcome: UnattendedSyncOutcome,
  audience: StalenessAudience = "claude",
): string[] {
  if (outcome.status !== "unfinished") return [];
  const reason = outcome.reason ?? "unknown reason";
  if (audience === "opencode") return launchRecoveryStalenessLines(outcome, ["opencode"]);
  return [
    `companion Git synchronization unfinished: ${reason} — run \`${COMPANION_SYNC_COMMAND}\``,
  ];
}

/**
 * The note for a session prepare, naming the managed launch of each wrapped
 * runtime as the recovery: it runs the sync at a terminal that can answer Git.
 */
export function launchRecoveryStalenessLines(
  outcome: UnattendedSyncOutcome,
  runtimes: readonly StalenessAudience[],
): string[] {
  if (outcome.status !== "unfinished") return [];
  const reason = outcome.reason ?? "unknown reason";
  const wrapped = new Set(runtimes);
  const launches = [
    ...(wrapped.has("claude") ? [CLAUDE_LAUNCH_COMMAND] : []),
    ...(wrapped.has("opencode") || wrapped.size === 0 ? [OPENCODE_LAUNCH_COMMAND] : []),
  ].map((command) => `\`${command}\``);
  return [`Companion not updated: ${reason}. Restart with ${launches.join(" or ")} to fix it.`];
}

/**
 * The note a session-state reader surfaces, taken from the persisted record so
 * a render costs no Git. Operator-facing only, exactly as the live note is.
 */
export function persistedCompanionGitStalenessLines(
  companionPath: string,
  homeDir?: string,
  audience: StalenessAudience = "claude",
): string[] {
  if (!companionPath) return [];
  const reason = readCompanionGitRecord(companionPath, homeDir).unfinishedReason;
  if (!reason) return [];
  return unattendedSyncStalenessLines(
    { status: "unfinished", changed: false, companionPath, reason },
    audience,
  );
}

export interface ForkGuardOptions {
  ttlMs?: number;
  timeoutMs?: number;
  now?: Date;
  homeDir?: string;
}

/**
 * The verdict both runtimes' artifact guards share, cached per interval so a
 * retry loop cannot spawn Git per write. `null` means "no refusal" — including
 * every case in which the check could not be completed, because the guard must
 * never fail closed.
 */
export async function companionForkRefusal(
  launch: boolean,
  companionPath: string,
  options: ForkGuardOptions = {},
): Promise<string | null> {
  if (!companionPath) return null;
  /**
   * A Managed Launch has already settled this session's Git question — by its
   * preflight, by `--no-git`, or by a companion whose Git handling is not
   * automatic. Refusing afterwards would revoke a documented bypass mid-session.
   */
  if (launch) return null;
  /** The same consent gate the repair holds: Git handling off makes this inert. */
  if (!readCompanionPolicy(companionPath).gitAutoMode) return null;

  const fork = await cachedCompanionForkState(companionPath, options);
  if (!fork?.forked) return null;
  return forkRefusalMessage(companionPath, fork);
}

export async function cachedCompanionForkState(
  companionPath: string,
  options: ForkGuardOptions = {},
): Promise<CompanionForkState | null> {
  const {
    ttlMs = FORK_VERDICT_TTL_MS,
    timeoutMs = GIT_QUERY_TIMEOUT_MS,
    now = new Date(),
    homeDir,
  } = options;

  const cached = readCachedForkRecord(companionPath, ttlMs, now, homeDir);
  if (cached) {
    return {
      ahead: cached.ahead,
      behind: cached.behind,
      forked: cached.ahead > 0 && cached.behind > 0,
    };
  }

  const fork = await companionForkState(companionPath, timeoutMs);
  if (!fork) return null;
  recordForkVerdict(companionPath, { ahead: fork.ahead, behind: fork.behind }, now, homeDir);
  return fork;
}

export function forkRefusalMessage(companionPath: string, fork: CompanionForkState): string {
  return [
    `${FRAMEWORK_NAME} guardrail: the companion's history has forked from its upstream.`,
    ` companion: ${companionPath}`,
    ` ${fork.ahead} local commit(s) ahead, ${fork.behind} upstream commit(s) behind`,
    `Writing artifacts now risks losing work in the reconciliation. Run \`${COMPANION_SYNC_COMMAND}\` first.`,
  ].join("\n");
}
