/**
 * Merge state from a local checkout: whether a delivery branch's head reached the default
 * branch. Only `git` is started. Local queries never reach the network
 * (`GIT_NO_LAZY_FETCH`); the fetch runs only when the caller decides to, never prompts,
 * and uses the user's own remote and credential setup unchanged.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { gitEnvironment, withGitConfig, withoutAskPass } from "../../runtime/companion-git";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs?: number },
) => Promise<ProcessResult>;

export interface PatchMatch {
  /** The commit on the default branch the delivery matched. */
  commit: string;
  /** `fast-forward`: the head is on the default branch's own line, which a branch without commits of its own is too. */
  style: "squash" | "rebase" | "fast-forward";
}

export interface FetchResult {
  ok: boolean;
  message?: string;
}

export interface MergeGit {
  /** True when the path is a Git work tree. */
  isRepository(): Promise<boolean>;
  /** `origin/<branch>`, else the local branch; null when neither exists. */
  tip(branch: string): Promise<string | null>;
  /** True when the commit exists locally, e.g. a recorded head after its branch was deleted. */
  hasCommit(commit: string): Promise<boolean>;
  /** True when `commit` is contained in `origin/<defaultBranch>`. */
  isAncestor(commit: string, defaultBranch: string): Promise<boolean>;
  /**
   * True when `commit`, already contained in `origin/<defaultBranch>`, lies on its
   * first-parent line: a fast-forward, or a branch that never had commits of its own.
   * False when a merge commit brought it in.
   */
  onFirstParent(commit: string, defaultBranch: string): Promise<boolean>;
  /**
   * The commit on `origin/<defaultBranch>` that carries the delivery's changes by patch
   * identity: every branch commit (rebase), else the whole branch diff (squash). Null in a
   * partial clone, without a match, or above {@link PATCH_MATCH_LIMIT} upstream commits.
   */
  patchMatch(head: string, defaultBranch: string): Promise<PatchMatch | null>;
  /** When `origin` was last fetched (ISO 8601), or null when unknown. */
  lastFetchedAt(): Promise<string | null>;
  /** Fetches the default branch, then the delivery branch; a missing branch is not a failure. */
  fetch(defaultBranch: string, branch: string): Promise<FetchResult>;
}

export interface MergeGitDeps {
  spawn?: SpawnProcess;
  env?: NodeJS.ProcessEnv;
}

/** Upstream commits compared by patch identity at most; more is asked instead. */
const PATCH_MATCH_LIMIT = 500;
const FETCH_BUDGET_MS = 20_000;
const QUERY_TIMEOUT_MS = 15_000;

export const spawnProcess: SpawnProcess = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: options.timeoutMs,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => resolve({ code: -1, stdout: "", stderr: error.message }));
    child.on("close", (code, signal) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(signal ? { timedOut: true } : {}),
      }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });

const remoteRef = (branch: string) => `refs/remotes/origin/${branch}`;

function fetchFailure(result: ProcessResult): FetchResult {
  return {
    ok: false,
    message: result.timedOut
      ? "git fetch timed out"
      : `git fetch failed: ${result.stderr.trim().split("\n").at(-1) || `exit ${result.code}`}`,
  };
}

/** `<patch-id> <commit>` lines from `git patch-id --stable`. */
function patchIds(output: string): Array<[string, string]> {
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts): parts is [string, string] => parts.length === 2 && parts[0] !== "");
}

export function mergeGit(repoPath: string, deps: MergeGitDeps = {}): MergeGit {
  const spawnFn = deps.spawn ?? spawnProcess;
  const base = gitEnvironment(deps.env ?? process.env) as NodeJS.ProcessEnv;
  const promptless: NodeJS.ProcessEnv = { ...withoutAskPass(base), GIT_TERMINAL_PROMPT: "0" };
  const localEnv: NodeJS.ProcessEnv = { ...promptless, GIT_NO_LAZY_FETCH: "1" };

  const git = (args: readonly string[], input?: string) =>
    spawnFn("git", args, { cwd: repoPath, env: localEnv, input, timeoutMs: QUERY_TIMEOUT_MS });
  const value = async (...args: string[]): Promise<string | null> => {
    const result = await git(args);
    return result.code === 0 ? result.stdout.trim() || null : null;
  };
  const verify = (ref: string) => value("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);

  const isPartialClone = async (): Promise<boolean> =>
    (await value("config", "--get", "remote.origin.promisor")) === "true" ||
    (await value("config", "--get", "extensions.partialClone")) !== null;

  /** Patch ids of `log -p` over a range, keyed by patch id. */
  const rangePatchIds = async (range: string): Promise<Map<string, string> | null> => {
    const log = await git(["log", "-p", "--no-merges", "--no-color", "--no-ext-diff", range]);
    if (log.code !== 0) return null;
    const ids = await git(["patch-id", "--stable"], log.stdout);
    if (ids.code !== 0) return null;
    return new Map(patchIds(ids.stdout));
  };

  return {
    async isRepository() {
      return (await value("rev-parse", "--is-inside-work-tree")) === "true";
    },
    async tip(branch) {
      return (await verify(remoteRef(branch))) ?? (await verify(`refs/heads/${branch}`));
    },
    async hasCommit(commit) {
      return (await git(["cat-file", "-e", `${commit}^{commit}`])).code === 0;
    },
    async isAncestor(commit, defaultBranch) {
      return (
        (await git(["merge-base", "--is-ancestor", commit, remoteRef(defaultBranch)])).code === 0
      );
    },
    async onFirstParent(commit, defaultBranch) {
      const line = await git([
        "rev-list",
        "--first-parent",
        remoteRef(defaultBranch),
        `^${commit}`,
      ]);
      if (line.code !== 0) return false;
      const oldest = line.stdout.trim().split("\n").at(-1);
      // Nothing listed: the head is the default branch's tip.
      if (!oldest) return true;
      return (await value("rev-parse", `${oldest}^1`)) === commit;
    },
    async patchMatch(head, defaultBranch) {
      if (await isPartialClone()) return null;
      const upstream = remoteRef(defaultBranch);
      const forkPoint = await value("merge-base", head, upstream);
      if (!forkPoint) return null;
      const count = Number(
        await value("rev-list", "--count", "--no-merges", `${forkPoint}..${upstream}`),
      );
      if (!count || count > PATCH_MATCH_LIMIT) return null;
      const upstreamIds = await rangePatchIds(`${forkPoint}..${upstream}`);
      const branchIds = await rangePatchIds(`${forkPoint}..${head}`);
      if (!upstreamIds || !branchIds || branchIds.size === 0) return null;

      const rebased = [...branchIds.keys()].map((id) => upstreamIds.get(id));
      if (rebased.every(Boolean)) {
        // `log` lists newest first, so the first match is where the rebase ended. One
        // commit looks the same squashed or rebased; it is reported as a squash.
        return {
          commit: rebased[0] as string,
          style: branchIds.size === 1 ? "squash" : "rebase",
        };
      }
      const diff = await git(["diff", "--no-color", "--no-ext-diff", forkPoint, head]);
      if (diff.code !== 0 || !diff.stdout) return null;
      const combined = await git(["patch-id", "--stable"], diff.stdout);
      const [entry] = combined.code === 0 ? patchIds(combined.stdout) : [];
      const squash = entry ? upstreamIds.get(entry[0]) : undefined;
      return squash ? { commit: squash, style: "squash" } : null;
    },
    async lastFetchedAt() {
      const fetchHead = await value("rev-parse", "--git-path", "FETCH_HEAD");
      if (!fetchHead) return null;
      try {
        const stat = await fs.stat(path.resolve(repoPath, fetchHead));
        return stat.mtime.toISOString();
      } catch {
        return null;
      }
    },
    async fetch(defaultBranch, branch) {
      const deadline = Date.now() + FETCH_BUDGET_MS;
      // No background maintenance or garbage collection from a fetch Mate started.
      const env: NodeJS.ProcessEnv = withGitConfig(
        { ...promptless, GCM_INTERACTIVE: "never" },
        { "maintenance.auto": "false", "gc.auto": "0" },
      );
      // A user's own SSH command wins; otherwise SSH must not ask for a passphrase.
      if (
        !base.GIT_SSH_COMMAND &&
        !base.GIT_SSH &&
        !(await value("config", "--get", "core.sshCommand"))
      ) {
        env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
      }
      const fetchRef = async (name: string): Promise<ProcessResult> => {
        // Names come from the shared Delivery Record: never fetch one Git would not accept.
        if ((await git(["check-ref-format", `refs/heads/${name}`])).code !== 0) {
          return { code: -1, stdout: "", stderr: `invalid branch name: ${name}` };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          return { code: -1, stdout: "", stderr: "fetch time budget spent", timedOut: true };
        return spawnFn(
          "git",
          [
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            "origin",
            `+refs/heads/${name}:${remoteRef(name)}`,
          ],
          { cwd: repoPath, env, timeoutMs: remaining },
        );
      };

      const main = await fetchRef(defaultBranch);
      if (main.code !== 0) return fetchFailure(main);
      if (branch === defaultBranch) return { ok: true };
      const delivery = await fetchRef(branch);
      // A branch deleted after its merge is expected; its recorded head still answers.
      if (delivery.code !== 0 && !/couldn't find remote ref/i.test(delivery.stderr)) {
        return fetchFailure(delivery);
      }
      return { ok: true };
    },
  };
}
