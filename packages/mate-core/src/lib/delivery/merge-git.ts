/**
 * Merge state from a local checkout: whether a delivery branch's head reached the default
 * branch, by ancestry or by content. Only `git` is started. Local queries never reach the
 * network (`GIT_NO_LAZY_FETCH`); the fetch and the pull-ref listing run only when the caller
 * decides to, never prompt, and use the user's own remote and credential setup unchanged.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
    /** Kills the process once aborted; the result then counts as timed out. */
    signal?: AbortSignal;
  },
) => Promise<ProcessResult>;

export interface PatchMatch {
  /** The commit on the default branch the delivery matched. */
  commit: string;
  /**
   * `fast-forward`: the head is on the default branch's own line, which a branch without commits
   * of its own is too. `merge`: a merge commit brought a head never pushed as its branch, as the
   * merge of a branch it was started from does.
   */
  style: "squash" | "rebase" | "fast-forward" | "merge";
}

export interface FetchResult {
  ok: boolean;
  message?: string;
  /** The delivery branch no longer exists on `origin`. */
  branchDeleted?: boolean;
  /** The delivery branch is missing on `origin` because its head was never pushed. */
  branchUnpushed?: boolean;
}

/** The first default-branch commit holding a delivery's content. */
export interface ContainingCommit {
  commit: string;
  /** Its committer time (ISO 8601). */
  committedAt: string;
}

/**
 * - a commit: the first on the default branch's first-parent line that contains the head
 * - `none`: no candidate commit contains it
 * - `unknown`: Git cannot tell: no `merge-tree --write-tree`, a missing object, a timeout, a
 *   head whose tree equals its merge base's (no content of its own), more candidates than
 *   {@link CONTAINMENT_LIMIT} without a hit, or a search past its time budget
 */
export type Containment = ContainingCommit | "none" | "unknown";

/** A pull or merge request head the remote advertises. */
export interface PullRef {
  number: number;
  /** `refs/pull/<n>/head` (GitHub) or `refs/merge-requests/<n>/head` (GitLab). Azure DevOps advertises neither. */
  ref: "pull" | "merge-requests";
  commit: string;
}

export interface MergeGit {
  /** True when the path is a Git work tree. */
  isRepository(): Promise<boolean>;
  /** The URL of `origin`, or null without one. */
  originUrl(): Promise<string | null>;
  /** `origin/<branch>`, else the local branch; null when neither exists. */
  tip(branch: string): Promise<string | null>;
  /** The local branch alone; null when it does not exist. */
  localTip(branch: string): Promise<string | null>;
  /** `origin/<branch>` alone, as last fetched; null when it does not exist. */
  remoteTip(branch: string): Promise<string | null>;
  /**
   * The work tree that has `branch` checked out and holds modified tracked files; null without
   * one. Untracked files do not count.
   */
  dirtyWorktree(branch: string): Promise<string | null>;
  /** True when `candidate` is another commit that descends from `base`. */
  aheadOf(base: string, candidate: string): Promise<boolean>;
  /** True when the commit exists locally, e.g. a recorded head after its branch was deleted. */
  hasCommit(commit: string): Promise<boolean>;
  /** True when `commit` is contained in `origin/<defaultBranch>`. */
  isAncestor(commit: string, defaultBranch: string): Promise<boolean>;
  /**
   * True when `commit`, already contained in `origin/<defaultBranch>`, lies on its
   * first-parent line: a fast-forward, or a branch that never had commits of its own.
   * False when a merge commit brought it in; null when Git could not tell.
   */
  onFirstParent(commit: string, defaultBranch: string): Promise<boolean | null>;
  /**
   * True when every entry of the local branch's reflog is `head`: the branch never moved since
   * it was created there. False when one differs; null without a reflog or when Git fails.
   */
  neverAdvanced(branch: string, head: string): Promise<boolean | null>;
  /**
   * The commit on `origin/<defaultBranch>` that carries the delivery's changes by patch
   * identity: every branch commit (rebase), else the whole branch diff (squash). Null in a
   * partial clone, without a match, or above {@link PATCH_MATCH_LIMIT} upstream commits.
   */
  patchMatch(head: string, defaultBranch: string): Promise<PatchMatch | null>;
  /** True when this Git has `merge-tree --write-tree` (2.38 or later); asked once per process. */
  supportsContainment(): Promise<boolean>;
  /**
   * True when merging `head` into `commit` changes nothing: the merge is clean and yields
   * `commit`'s own tree. Null when Git cannot tell (missing object, timeout, no support).
   */
  contains(commit: string, head: string): Promise<boolean | null>;
  /**
   * The oldest commit on `origin/<defaultBranch>`'s first-parent line after the merge base that
   * contains `head`, among those committed at most a day before `head`, at most
   * {@link CONTAINMENT_LIMIT}. For a head that is not an ancestor of the default branch.
   */
  firstContaining(head: string, defaultBranch: string): Promise<Containment>;
  /** When `origin` was last fetched (ISO 8601), or null when unknown. */
  lastFetchedAt(): Promise<string | null>;
  /**
   * Fetches the default branch, then the delivery branch; a missing branch is not a failure but
   * `branchDeleted`.
   */
  fetch(defaultBranch: string, branch: string): Promise<FetchResult>;
  /** The pull and merge request heads `origin` advertises; null when the listing failed. */
  pullRefs(): Promise<PullRef[] | null>;
  /** Fetches one PR head, leaving no ref and `FETCH_HEAD` untouched; its commit, or null. */
  fetchPullHead(number: number, ref: PullRef["ref"]): Promise<string | null>;
}

export interface MergeGitDeps {
  spawn?: SpawnProcess;
  env?: NodeJS.ProcessEnv;
  /** Candidate commits tested for containment at most; {@link CONTAINMENT_LIMIT} by default. */
  containmentLimit?: number;
  /** Wall time one containment search may take; 5 s by default. */
  containmentBudgetMs?: number;
  /** Once aborted, running Git commands are killed and new ones fail at once. */
  signal?: AbortSignal;
}

/** Upstream commits compared by patch identity at most; more is asked instead. */
const PATCH_MATCH_LIMIT = 500;
/** Default-branch commits tested for containment at most. */
export const CONTAINMENT_LIMIT = 200;
/** Wall time one containment search may take; past it the answer is `unknown`. */
const CONTAINMENT_BUDGET_MS = 5_000;
/** Heads no candidate contained, by checkout, head and default tip; the answer cannot change. */
const notContainedBySpawn = new WeakMap<SpawnProcess, Set<string>>();
const NOT_CONTAINED_MAX = 1_000;

/** `spawnFn`'s set in {@link notContainedBySpawn}, created on first use. */
function notContainedMemo(spawnFn: SpawnProcess): Set<string> {
  let memo = notContainedBySpawn.get(spawnFn);
  if (!memo) {
    memo = new Set();
    notContainedBySpawn.set(spawnFn, memo);
  }
  return memo;
}
/** Candidates committed this long before the head still count: clocks and rebases differ. */
const CONTAINMENT_SLACK_SECONDS = 24 * 60 * 60;
const FETCH_BUDGET_MS = 20_000;
const QUERY_TIMEOUT_MS = 15_000;
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** `merge-tree --write-tree` support, probed once per process for each spawner. */
const containmentSupport = new WeakMap<SpawnProcess, Promise<boolean>>();

/** True for `git version` output of Git 2.38 or later. */
function hasWriteTree(version: string): boolean {
  const match = /git version (\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 2 || (major === 2 && minor >= 38);
}

export const spawnProcess: SpawnProcess = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) =>
      resolve({
        code: -1,
        stdout: "",
        stderr: error.message,
        ...(options.signal?.aborted ? { timedOut: true } : {}),
      }),
    );
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

function promptlessEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...withoutAskPass(base), GIT_TERMINAL_PROMPT: "0" };
}

/** Environment for local Git queries: never prompts, never fetches lazily. */
export function localGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...promptlessEnv(gitEnvironment(env) as NodeJS.ProcessEnv),
    GIT_NO_LAZY_FETCH: "1",
  };
}

export function mergeGit(repoPath: string, deps: MergeGitDeps = {}): MergeGit {
  const baseSpawn = deps.spawn ?? spawnProcess;
  const spawnFn: SpawnProcess = deps.signal
    ? (command, args, options) => baseSpawn(command, args, { ...options, signal: deps.signal })
    : baseSpawn;
  const base = gitEnvironment(deps.env ?? process.env) as NodeJS.ProcessEnv;
  const promptless = promptlessEnv(base);
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

  const supportsContainment = (): Promise<boolean> => {
    let known = containmentSupport.get(baseSpawn);
    if (!known) {
      known = git(["version"]).then((result) => {
        // A killed probe proves nothing about this Git.
        if (result.timedOut) containmentSupport.delete(baseSpawn);
        return result.code === 0 && hasWriteTree(result.stdout);
      });
      containmentSupport.set(baseSpawn, known);
    }
    return known;
  };

  const contains = async (commit: string, head: string): Promise<boolean | null> => {
    if (!(await supportsContainment())) return null;
    const tree = await value("rev-parse", "--verify", "--quiet", `${commit}^{tree}`);
    if (!tree) return null;
    const merged = await git(["merge-tree", "--write-tree", "--no-messages", commit, head]);
    if (merged.timedOut) return null;
    // 1: the merge conflicts; anything else is Git failing, e.g. on a missing object.
    if (merged.code === 1) return false;
    if (merged.code !== 0) return null;
    return merged.stdout.split("\n")[0]?.trim() === tree;
  };

  /** Network Git: never prompts, no background maintenance, the user's credentials unchanged. */
  const networkEnv = async (): Promise<NodeJS.ProcessEnv> => {
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
    return env;
  };

  const network = async (args: readonly string[]): Promise<ProcessResult> =>
    spawnFn("git", args, { cwd: repoPath, env: await networkEnv(), timeoutMs: FETCH_BUDGET_MS });

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
    originUrl() {
      return value("config", "--get", "remote.origin.url");
    },
    async tip(branch) {
      return (await verify(remoteRef(branch))) ?? (await verify(`refs/heads/${branch}`));
    },
    localTip(branch) {
      return verify(`refs/heads/${branch}`);
    },
    remoteTip(branch) {
      return verify(remoteRef(branch));
    },
    async dirtyWorktree(branch) {
      const listed = await value("worktree", "list", "--porcelain");
      for (const entry of (listed ?? "").split("\n\n")) {
        const lines = entry.split("\n");
        const dir = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
        if (!dir || !lines.includes(`branch refs/heads/${branch}`)) continue;
        // oxlint-disable-next-line no-await-in-loop -- a branch is checked out in one work tree
        const status = await git([
          "--no-optional-locks",
          "-C",
          dir,
          "status",
          "--porcelain",
          "--untracked-files=no",
        ]);
        if (status.code === 0 && status.stdout.trim()) return dir;
      }
      return null;
    },
    async aheadOf(ancestor, candidate) {
      if (ancestor === candidate) return false;
      return (await git(["merge-base", "--is-ancestor", ancestor, candidate])).code === 0;
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
      if (line.code !== 0) return null;
      const oldest = line.stdout.trim().split("\n").at(-1);
      // Nothing listed: the head is the default branch's tip.
      if (!oldest) return true;
      const parent = await value("rev-parse", `${oldest}^1`);
      return parent ? parent === commit : null;
    },
    async neverAdvanced(branch, head) {
      const reflog = await git(["reflog", "show", "--format=%H", `refs/heads/${branch}`, "--"]);
      if (reflog.code !== 0) return null;
      const entries = reflog.stdout
        .split("\n")
        .map((entry) => entry.trim())
        .filter(Boolean);
      return entries.length > 0 ? entries.every((entry) => entry === head) : null;
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
    supportsContainment,
    contains,
    async firstContaining(head, defaultBranch) {
      if (!(await supportsContainment())) return "unknown";
      const upstream = remoteRef(defaultBranch);
      const tip = await verify(upstream);
      const notContained = notContainedMemo(baseSpawn);
      const key = `${repoPath}\0${head}\0${tip}`;
      // Unchanged head and default tip: a repeated refresh does not test every candidate again.
      if (tip && notContained.has(key)) return "none";
      const mergeBase = await value("merge-base", head, upstream);
      const headTime = Number(await value("show", "-s", "--format=%ct", head));
      if (!mergeBase || !headTime) return "unknown";
      // Like a branch without commits of its own on the ancestry path: every later commit
      // would "contain" it, so only the user can tell.
      const [baseTree, headTree] = await Promise.all([
        value("rev-parse", "--verify", "--quiet", `${mergeBase}^{tree}`),
        value("rev-parse", "--verify", "--quiet", `${head}^{tree}`),
      ]);
      if (!baseTree || baseTree === headTree) return "unknown";
      const listed = await git([
        "log",
        "--first-parent",
        "--reverse",
        "--format=%H %ct %cI",
        `${mergeBase}..${upstream}`,
        "--",
      ]);
      if (listed.code !== 0) return "unknown";
      const candidates = listed.stdout
        .split("\n")
        .map((line) => line.trim().split(" "))
        .filter(([, time]) => Number(time) >= headTime - CONTAINMENT_SLACK_SECONDS);
      const limit = deps.containmentLimit ?? CONTAINMENT_LIMIT;
      const deadline = Date.now() + (deps.containmentBudgetMs ?? CONTAINMENT_BUDGET_MS);
      for (const [commit, , committedAt] of candidates.slice(0, limit)) {
        if (Date.now() >= deadline) return "unknown";
        // oxlint-disable-next-line no-await-in-loop -- oldest first, stops at the first hit
        const answer = await contains(commit!, head);
        if (answer === null) return "unknown";
        if (answer) return { commit: commit!, committedAt: new Date(committedAt!).toISOString() };
      }
      if (candidates.length > limit) return "unknown";
      if (tip) {
        if (notContained.size >= NOT_CONTAINED_MAX) notContained.clear();
        notContained.add(key);
      }
      return "none";
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
      const env = await networkEnv();
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
      if (delivery.code !== 0 && /couldn't find remote ref/i.test(delivery.stderr)) {
        return { ok: true, branchDeleted: true };
      }
      if (delivery.code !== 0) return fetchFailure(delivery);
      return { ok: true };
    },
    async pullRefs() {
      const listed = await network([
        "ls-remote",
        "origin",
        "refs/pull/*/head",
        "refs/merge-requests/*/head",
      ]);
      if (listed.code !== 0) return null;
      return listed.stdout.split("\n").flatMap((line) => {
        const [commit, name] = line.trim().split(/\s+/);
        const match = name ? /^refs\/(pull|merge-requests)\/(\d+)\/head$/.exec(name) : null;
        if (!commit || !match || !COMMIT_ID.test(commit)) return [];
        return [{ number: Number(match[2]), ref: match[1] as PullRef["ref"], commit }];
      });
    },
    async fetchPullHead(number, ref) {
      if (!Number.isSafeInteger(number) || number <= 0) return null;
      // Into a private ref removed again, not `FETCH_HEAD`: its time tells when origin was
      // last fetched, and the user may be about to merge it.
      const target = `refs/mate/pull-head/${randomUUID()}`;
      const fetched = await network([
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        "origin",
        `+refs/${ref}/${number}/head:${target}`,
      ]);
      if (fetched.code !== 0) return null;
      const head = await verify(target);
      await git(["update-ref", "-d", target]);
      return head;
    },
  };
}
