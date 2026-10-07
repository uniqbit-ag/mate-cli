/**
 * Companion Git: the one place remote-facing Git on a Companion Repository is
 * run. It owns the policy every caller shares (inherited `GIT_*` overrides
 * cleared, SSH first for HTTP(S) remotes, one prompt decision for Git and SSH,
 * one time budget per operation) and the decision steps every synchronization
 * shares (upstream target, fork state). Callers keep only their tails.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
  /** The operation's time bound ended the command, or kept it from starting. */
  timedOut?: boolean;
}

export interface UpstreamTarget {
  remote: string;
  branch: string;
  ref: string;
}

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

/** `git@host:path` (`ssh://` when a port is given) for an HTTP(S) Git URL; `null` otherwise. */
export function toSshUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname || parsed.pathname === "/") return null;

    const repositoryPath = parsed.pathname.replace(/^\/+/, "");
    if (!repositoryPath) return null;

    if (!parsed.port) return `git@${parsed.hostname}:${repositoryPath}`;
    return `ssh://git@${parsed.hostname}:${parsed.port}/${repositoryPath}`;
  } catch {
    return null;
  }
}

/** Lists every configured remote URL, one `remote.<name>.<key> <url>` per line. */
export const REMOTE_URLS_QUERY: readonly string[] = [
  "config",
  "--get-regexp",
  String.raw`^remote\..+\.(url|pushurl)$`,
];

/**
 * `-c url.<ssh>.insteadOf=<https>` per HTTP(S) remote in `REMOTE_URLS_QUERY`
 * output, so one invocation reaches every remote over SSH without rewriting
 * the stored configuration. Empty when no remote is HTTP(S).
 */
export function sshRewriteArgs(remoteUrlsOutput: string): string[] {
  const urls = new Set(
    outputLines(remoteUrlsOutput).flatMap((line) => {
      const url = line.slice(line.indexOf(" ") + 1).trim();
      return url ? [url] : [];
    }),
  );
  return [...urls].flatMap((url) => {
    const ssh = toSshUrl(url);
    return ssh ? ["-c", `url.${ssh}.insteadOf=${url}`] : [];
  });
}

/** A remote rejection is a verdict the configured URL would repeat; anything else may be SSH-only. */
export function shouldRetryWithoutSsh(result: GitResult): boolean {
  if (result.status === 0) return false;
  return !/\[(?:remote )?rejected\]/.test(`${result.stderr}\n${result.stdout}`);
}

/**
 * Inherited `GIT_*` overrides would point Git at the session's own repository
 * rather than the one named, so they are stripped from every invocation.
 * Prompting is not decided here.
 */
export function gitEnvironment(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const {
    GIT_DIR: _gitDir,
    GIT_WORK_TREE: _gitWorkTree,
    GIT_COMMON_DIR: _gitCommonDir,
    GIT_INDEX_FILE: _gitIndexFile,
    ...rest
  } = env;
  return rest;
}

/**
 * Who may answer a prompt. One decision covers Git credential prompts and SSH
 * passphrase and host-key prompts together; `if-terminal` without a TTY is
 * `never`.
 */
export type GitPromptIntent = "never" | "if-terminal";

export type GitTransport = "ssh" | "http" | "other";

export interface NetworkGitResult extends GitResult {
  /** Transport of the attempt whose result this is. */
  transport: GitTransport;
}

export interface CompanionGitOptions {
  prompt: GitPromptIntent;
  /** Bound on the whole operation, every command and fallback included. Unbounded when absent. */
  budgetMs?: number;
  /** Bound on each local command, applied within `budgetMs`. */
  commandCapMs?: number;
  env?: Record<string, string | undefined>;
}

export interface CompanionGit {
  /** Local command, captured. */
  run(args: readonly string[]): Promise<GitResult>;
  /** `git fetch <args>`, SSH first for HTTP(S) remotes. */
  fetch(args?: readonly string[]): Promise<NetworkGitResult>;
  /** `git push <args>`, SSH first for HTTP(S) remotes. */
  push(args?: readonly string[]): Promise<NetworkGitResult>;
  /** Clones `url` into `destination` (relative to the operation's directory), SSH first for HTTP(S). */
  clone(url: string, destination: string, options?: { branch?: string }): Promise<NetworkGitResult>;
  upstreamTarget(): Promise<UpstreamTarget | null>;
  /** Against `ref`, else the resolved upstream target. Local refs only; never fetches. */
  forkState(ref?: string): Promise<CompanionForkState | null>;
}

export const companionGitDeps = {
  isTerminal: (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY),
};

const SSH_URL = /^(?:ssh:\/\/|[^/@:\s]+@[^/:\s]+:)/i;

function transportOf(url: string): GitTransport {
  if (/^https?:\/\//i.test(url)) return "http";
  return SSH_URL.test(url) ? "ssh" : "other";
}

/** Of `REMOTE_URLS_QUERY` lines: SSH if any remote uses it, else HTTP if any does. */
function configuredTransport(remoteUrlLines: string[]): GitTransport {
  const transports = new Set(remoteUrlLines.map((line) => transportOf(line.split(" ")[1] ?? "")));
  if (transports.has("ssh")) return "ssh";
  if (transports.has("http")) return "http";
  return "other";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function decode(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8");
}

function spawnGit(
  cwd: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
  options: { interactive: boolean; timeoutMs?: number },
): Promise<GitResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const finish = (result: GitResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn("git", [...args], {
        cwd,
        env,
        /** Interactive output goes to stderr so a caller's stdout (e.g. `--json`) stays clean. */
        stdio: options.interactive ? ["inherit", 2, "inherit"] : ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ status: 1, stdout: "", stderr: (error as Error).message });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => finish({ status: 1, stdout: "", stderr: error.message }));
    child.once("close", (status) =>
      finish({ status: status ?? 1, stdout: decode(stdout), stderr: decode(stderr) }),
    );
    if (options.timeoutMs !== undefined) {
      /** Resolved without awaiting `close`: an SSH grandchild may hold the pipes open. */
      timer = setTimeout(
        () => {
          child.kill("SIGKILL");
          finish({
            status: 1,
            stdout: decode(stdout),
            stderr:
              `${decode(stderr)}\ngit ${args.join(" ")}: exceeded the operation's time bound`.trim(),
            timedOut: true,
          });
        },
        Math.max(1, options.timeoutMs),
      );
    }
  });
}

/**
 * `GIT_TERMINAL_PROMPT=0` leaves askpass helpers (an editor's credential UI)
 * free to prompt, so `never` clears every askpass source: both variables, and
 * `core.askPass` through an appended `GIT_CONFIG_*` entry.
 */
function withoutAskPass(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const { GIT_ASKPASS: _gitAskPass, SSH_ASKPASS: _sshAskPass, ...rest } = env;
  const count = Number.parseInt(rest.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  return {
    ...rest,
    SSH_ASKPASS_REQUIRE: "never",
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: "core.askPass",
    [`GIT_CONFIG_VALUE_${count}`]: "",
  };
}

/** The operation's policy is fixed when it is opened; every step below inherits it. */
export function companionGit(
  cwd: string,
  options: CompanionGitOptions,
  deps: typeof companionGitDeps = companionGitDeps,
): CompanionGit {
  const baseEnv = gitEnvironment(options.env ?? process.env);
  const mayPrompt = options.prompt === "if-terminal" && deps.isTerminal();
  const deadline =
    options.budgetMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + options.budgetMs;
  const capturedEnv = mayPrompt
    ? { ...baseEnv, GIT_TERMINAL_PROMPT: "0" }
    : withoutAskPass({ ...baseEnv, GIT_TERMINAL_PROMPT: "0" });
  const { GIT_TERMINAL_PROMPT: _prompt, ...promptingEnv } = baseEnv;
  let networkEnv: Promise<Record<string, string | undefined>> | undefined;

  async function exec(
    args: readonly string[],
    env: Record<string, string | undefined>,
    { interactive = false, capMs }: { interactive?: boolean; capMs?: number } = {},
  ): Promise<GitResult> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        status: 1,
        stdout: "",
        stderr: `git ${args.join(" ")}: not started, the operation's time bound is spent`,
        timedOut: true,
      };
    }
    const timeoutMs = Math.min(remaining, capMs ?? Number.POSITIVE_INFINITY);
    return spawnGit(cwd, args, env, {
      interactive,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    });
  }

  const run = (args: readonly string[]) => exec(args, capturedEnv, { capMs: options.commandCapMs });

  /**
   * `never` appends `BatchMode=yes` to the SSH command Git would use anyway
   * (`GIT_SSH_COMMAND`, `GIT_SSH`, `core.sshCommand`, then `ssh`), so SSH
   * neither asks for a passphrase nor confirms a host key.
   */
  function sshEnv(): Promise<Record<string, string | undefined>> {
    networkEnv ??= (async () => {
      if (mayPrompt) return capturedEnv;
      let command = baseEnv.GIT_SSH_COMMAND;
      if (!command && baseEnv.GIT_SSH) command = shellQuote(baseEnv.GIT_SSH);
      if (!command) {
        const configured = await run(["config", "--get", "core.sshCommand"]);
        command = configured.status === 0 ? configured.stdout.trim() : "";
      }
      return {
        ...capturedEnv,
        GIT_SSH_COMMAND: `${command || "ssh"} -o BatchMode=yes`,
      };
    })();
    return networkEnv;
  }

  /** Only the configured-URL attempt may own the terminal; the SSH attempt stays captured. */
  async function attempt(
    args: readonly string[],
    transport: GitTransport,
    configured: boolean,
  ): Promise<NetworkGitResult> {
    const interactive = configured && mayPrompt;
    const env = interactive ? promptingEnv : await sshEnv();
    const result = await exec(args, env, { interactive });
    return { ...result, transport };
  }

  async function remoteNetwork(args: readonly string[]): Promise<NetworkGitResult> {
    const remotes = await run(REMOTE_URLS_QUERY);
    const rewrite = remotes.status === 0 ? sshRewriteArgs(remotes.stdout) : [];
    if (rewrite.length > 0) {
      const overSsh = await attempt([...rewrite, ...args], "ssh", false);
      if (!shouldRetryWithoutSsh(overSsh) || overSsh.timedOut) return overSsh;
      return attempt(args, "http", true);
    }
    const urls = remotes.status === 0 ? outputLines(remotes.stdout) : [];
    return attempt(args, configuredTransport(urls), true);
  }

  async function forkStateAt(ref: string): Promise<CompanionForkState | null> {
    const counts = await run(["rev-list", "--left-right", "--count", `${ref}...HEAD`]);
    if (counts.status !== 0) return null;
    const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
    return { ahead, behind, forked: ahead > 0 && behind > 0 };
  }

  const upstreamTarget = () => resolveUpstreamTarget(run);

  return {
    run,
    fetch: (args = []) => remoteNetwork(["fetch", ...args]),
    push: (args = []) => remoteNetwork(["push", ...args]),
    async clone(url, destination, { branch } = {}) {
      const cloneArgs = ["clone", ...(branch ? ["--branch", branch] : []), url, destination];
      const ssh = toSshUrl(url);
      if (ssh) {
        const existed = fs.existsSync(path.resolve(cwd, destination));
        const overSsh = await attempt(
          ["-c", `url.${ssh}.insteadOf=${url}`, ...cloneArgs],
          "ssh",
          false,
        );
        if (!shouldRetryWithoutSsh(overSsh) || overSsh.timedOut) return overSsh;
        if (!existed) fs.rmSync(path.resolve(cwd, destination), { recursive: true, force: true });
        return attempt(cloneArgs, "http", true);
      }
      return attempt(cloneArgs, transportOf(url), true);
    },
    upstreamTarget,
    async forkState(ref) {
      if (ref) return forkStateAt(ref);
      const target = await upstreamTarget();
      return target ? forkStateAt(target.ref) : null;
    },
  };
}

function parseRemoteRef(stdout: string): UpstreamTarget | undefined {
  const ref = stdout.trim();
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator === ref.length - 1) return undefined;
  return { remote: ref.slice(0, separator), branch: ref.slice(separator + 1), ref };
}

/**
 * The single definition of "which upstream does this companion mean": the
 * branch's `@{u}`, then `origin/HEAD`, then an available `origin/main` or
 * `origin/master`.
 */
async function resolveUpstreamTarget(
  run: (args: readonly string[]) => Promise<GitResult>,
): Promise<UpstreamTarget | null> {
  const upstream = await run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const configured = parseRemoteRef(upstream.stdout);
  if (upstream.status === 0 && configured) return configured;

  const remoteHead = await run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const fromRemoteHead = parseRemoteRef(remoteHead.stdout);
  if (remoteHead.status === 0 && fromRemoteHead) return fromRemoteHead;

  for (const branch of ["main", "master"]) {
    // oxlint-disable-next-line no-await-in-loop -- the steps are a decision chain
    const exists = await run(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
    if (exists.status === 0) return { remote: "origin", branch, ref: `origin/${branch}` };
  }

  return null;
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
): Promise<CompanionForkState | null> {
  return companionGit(companionPath, { prompt: "never", commandCapMs: timeoutMs }).forkState();
}
