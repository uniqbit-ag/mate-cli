/**
 * Git primitives shared by the launch preflight and the session-runtime
 * surfaces. Upstream-ref resolution lives here because two callers depend on
 * meaning the same ref: `CompanionGitSync` (async, injectable runner) and the
 * hooks (synchronous `spawnSync`). The resolution is expressed once as a step
 * generator that both drivers run, so the two can never disagree.
 */
import { spawnSync } from "node:child_process";

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface UpstreamTarget {
  remote: string;
  branch: string;
  ref: string;
}

/** Bounded but far above any diagnostic output; 1 MiB truncates large fetches. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Refs already local: no network, so a small bound is generous. */
export const GIT_QUERY_TIMEOUT_MS = 5_000;

export function outputLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Matches Git progress-meter lines such as `Updating files:  76% (11340/14790)` or `..., done.` */
const GIT_PROGRESS_LINE = /^\S.*?: +\d+% \(\d+\/\d+\)(?:, done\.)?$/;

export function stripGitProgress(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .filter((line) => !GIT_PROGRESS_LINE.test(line.trim()))
    .join("\n")
    .trim();
}

export function describeGitFailure(result: GitResult): string {
  return stripGitProgress(result.stderr) || stripGitProgress(result.stdout) || "unknown Git error";
}

export function isAuthenticationFailure(result: GitResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return [
    "terminal prompts disabled",
    "could not read username",
    "could not read password",
    "authentication failed",
    "permission denied (publickey)",
    "could not open /dev/tty",
    "can't open /dev/tty",
    "cannot open /dev/tty",
  ].some((marker) => output.includes(marker));
}

/**
 * Inherited `GIT_*` overrides would point Git at the session's own repository
 * rather than the companion, so they are stripped from every invocation.
 */
export function gitEnvironment(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const {
    GIT_DIR: _gitDir,
    GIT_WORK_TREE: _gitWorkTree,
    GIT_COMMON_DIR: _gitCommonDir,
    GIT_INDEX_FILE: _gitIndexFile,
    GIT_TERMINAL_PROMPT: _gitTerminalPrompt,
    ...rest
  } = env;
  return { ...rest, GIT_TERMINAL_PROMPT: "0" };
}

/** Never throws: an absent Git binary and an exceeded bound are ordinary results. */
export function runGitSync(
  cwd: string,
  args: readonly string[],
  timeoutMs: number = GIT_QUERY_TIMEOUT_MS,
): GitResult {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: gitEnvironment(),
    maxBuffer: GIT_MAX_BUFFER,
    timeout: Math.max(1, timeoutMs),
  });
  if (result.error) {
    return { status: 1, stdout: result.stdout ?? "", stderr: result.error.message };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function parseRemoteRef(stdout: string): UpstreamTarget | undefined {
  const ref = stdout.trim();
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator === ref.length - 1) return undefined;
  return { remote: ref.slice(0, separator), branch: ref.slice(separator + 1), ref };
}

/**
 * The single definition of "which upstream does this companion mean":
 * the branch's `@{u}`, then `origin/HEAD`, then an available `origin/main` or
 * `origin/master`. Yields argv, receives the result — so a synchronous and an
 * asynchronous driver share one decision procedure.
 */
export function* upstreamTargetSteps(): Generator<
  readonly string[],
  UpstreamTarget | null,
  GitResult
> {
  const upstream = yield ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"];
  const configured = parseRemoteRef(upstream.stdout);
  if (upstream.status === 0 && configured) return configured;

  const remoteHead = yield ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"];
  const fromRemoteHead = parseRemoteRef(remoteHead.stdout);
  if (remoteHead.status === 0 && fromRemoteHead) return fromRemoteHead;

  for (const branch of ["main", "master"]) {
    const exists = yield ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`];
    if (exists.status === 0) return { remote: "origin", branch, ref: `origin/${branch}` };
  }

  return null;
}

export function resolveUpstreamTargetSync(
  companionPath: string,
  timeoutMs: number = GIT_QUERY_TIMEOUT_MS,
): UpstreamTarget | null {
  const steps = upstreamTargetSteps();
  let step = steps.next();
  while (!step.done) {
    step = steps.next(runGitSync(companionPath, step.value, timeoutMs));
  }
  return step.value;
}

export async function resolveUpstreamTargetWith(
  run: (args: readonly string[]) => Promise<GitResult>,
): Promise<UpstreamTarget | null> {
  const steps = upstreamTargetSteps();
  let step = steps.next();
  while (!step.done) {
    // oxlint-disable-next-line no-await-in-loop -- the steps are a decision chain
    step = steps.next(await run(step.value));
  }
  return step.value;
}

export interface CompanionForkState {
  ahead: number;
  behind: number;
  /**
   * Only ahead *and* behind. Ahead alone is the ordinary state of a session
   * that has committed artifacts and not yet finished; behind alone a
   * fast-forward resolves without a human.
   */
  forked: boolean;
}

/**
 * Computed from refs already present locally — never fetches. `null` means the
 * question could not be answered (no upstream ref, no working tree, no Git,
 * exceeded bound), and every caller must fall through rather than refuse.
 */
export function companionForkState(
  companionPath: string,
  timeoutMs: number = GIT_QUERY_TIMEOUT_MS,
): CompanionForkState | null {
  const target = resolveUpstreamTargetSync(companionPath, timeoutMs);
  if (!target) return null;
  return forkStateAgainst(companionPath, target.ref, timeoutMs);
}

export function forkStateAgainst(
  companionPath: string,
  ref: string,
  timeoutMs: number = GIT_QUERY_TIMEOUT_MS,
): CompanionForkState | null {
  const counts = runGitSync(
    companionPath,
    ["rev-list", "--left-right", "--count", `${ref}...HEAD`],
    timeoutMs,
  );
  if (counts.status !== 0) return null;

  const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
  return { ahead, behind, forked: ahead > 0 && behind > 0 };
}
