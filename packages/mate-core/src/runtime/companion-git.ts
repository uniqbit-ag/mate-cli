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

/**
 * Blob contents by spec from the output of `git cat-file --batch` fed `specs`, one per line.
 * Per spec, in order: `<oid> <type> <size>\n<contents>\n`, or `<spec> missing\n`; missing
 * and non-blob objects are left out. Null when the output is cut off or malformed.
 */
export function parseBlobBatch(out: Buffer, specs: readonly string[]): Map<string, string> | null {
  const blobs = new Map<string, string>();
  let offset = 0;
  for (const spec of specs) {
    const end = out.indexOf(10, offset);
    if (end < 0) return null;
    const line = out.subarray(offset, end).toString("utf8");
    offset = end + 1;
    // The spec is echoed, spaces and all, so these are read off the end.
    if (line.endsWith(" missing") || line.endsWith(" ambiguous")) continue;
    const header = line.split(" ");
    if (header.length !== 3) continue;
    const size = Number(header[2]);
    if (!Number.isInteger(size) || offset + size > out.length) return null;
    if (header[1] === "blob") blobs.set(spec, out.subarray(offset, offset + size).toString("utf8"));
    offset += size + 1;
  }
  return blobs;
}

/** Paths of a `-z` listing, unquoted, so a non-ASCII path survives. */
export function nulPaths(stdout: string): string[] {
  return stdout.split("\0").filter(Boolean);
}

/**
 * Git option that reads pathspecs as plain paths. A change name may hold `*`, `?` or `[`, and
 * on the inbox it is a teammate's: as a pattern it would match other changes' folders.
 */
export const LITERAL_PATHSPECS: readonly string[] = ["--literal-pathspecs"];

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

const NETWORK_FAILURE_MARKERS = [
  "could not resolve host",
  "connection timed out",
  "connection refused",
  "connection reset",
  "operation timed out",
  "the remote end hung up unexpectedly",
  "kex_exchange_identification",
  "early eof",
];

const REMOTE_REJECTION = /\[(?:remote )?rejected\]|non-fast-forward|protected branch/;

/**
 * A remote failure a retry may cure: an authentication rejection or a network
 * failure. A rejection by the remote's rules never is, whatever else it prints.
 */
export function isTransientRemoteFailure(result: GitResult): boolean {
  if (result.status === 0) return false;
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (REMOTE_REJECTION.test(output)) return false;
  return (
    Boolean(result.timedOut) ||
    isAuthenticationFailure(result) ||
    NETWORK_FAILURE_MARKERS.some((marker) => output.includes(marker))
  );
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
  /** Index file local commands use instead of the repository's own. */
  indexFile?: string;
}

export interface CompanionGit {
  /** Local command, captured. */
  run(args: readonly string[]): Promise<GitResult>;
  /**
   * Contents of the blobs `ids` by id, decoded as text, read in one `git cat-file --batch`
   * however many there are. Ids that name no blob are left out; null when the command fails.
   */
  readBlobs(ids: readonly string[]): Promise<Map<string, string> | null>;
  /** `git fetch <args>`, SSH first for HTTP(S) remotes. */
  fetch(args?: readonly string[]): Promise<NetworkGitResult>;
  /** `git <gitOptions> push <args>`, SSH first for HTTP(S) remotes. */
  push(args?: readonly string[], gitOptions?: readonly string[]): Promise<NetworkGitResult>;
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
  options: { interactive: boolean; timeoutMs?: number; input?: string },
): Promise<GitResult & { bytes?: Buffer }> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const piped = options.input !== undefined;
    const finish = (result: GitResult & { bytes?: Buffer }) => {
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
        stdio: options.interactive
          ? ["inherit", 2, "inherit"]
          : [piped ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ status: 1, stdout: "", stderr: (error as Error).message });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => finish({ status: 1, stdout: "", stderr: error.message }));
    child.once("close", (status) =>
      finish({
        status: status ?? 1,
        // Byte offsets matter to a caller that pipes input; the others read text.
        ...(piped ? { stdout: "", bytes: Buffer.concat(stdout) } : { stdout: decode(stdout) }),
        stderr: decode(stderr),
      }),
    );
    if (piped) {
      // A command that exits early closes the pipe; its status reports the failure.
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.input);
    }
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
export function withoutAskPass(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const { GIT_ASKPASS: _gitAskPass, SSH_ASKPASS: _sshAskPass, ...rest } = env;
  return withGitConfig({ ...rest, SSH_ASKPASS_REQUIRE: "never" }, { "core.askPass": "" });
}

/** `env` with `config` appended as `GIT_CONFIG_*` entries, after any already there. */
export function withGitConfig(
  env: Record<string, string | undefined>,
  config: Record<string, string>,
): Record<string, string | undefined> {
  const next: Record<string, string | undefined> = { ...env };
  let count = Number.parseInt(next.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  for (const [key, value] of Object.entries(config)) {
    next[`GIT_CONFIG_KEY_${count}`] = key;
    next[`GIT_CONFIG_VALUE_${count}`] = value;
    count += 1;
  }
  next.GIT_CONFIG_COUNT = String(count);
  return next;
}

/** The operation's policy is fixed when it is opened; every step below inherits it. */
export function companionGit(
  cwd: string,
  options: CompanionGitOptions,
  deps: typeof companionGitDeps = companionGitDeps,
): CompanionGit {
  const baseEnv: Record<string, string | undefined> = {
    ...gitEnvironment(options.env ?? process.env),
    // Failures are told apart by Git's English messages.
    LC_ALL: "C",
    ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
  };
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
    {
      interactive = false,
      capMs,
      input,
    }: { interactive?: boolean; capMs?: number; input?: string } = {},
  ): Promise<GitResult & { bytes?: Buffer }> {
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
      ...(input === undefined ? {} : { input }),
    });
  }

  const run = (args: readonly string[]) => exec(args, capturedEnv, { capMs: options.commandCapMs });

  async function readBlobs(ids: readonly string[]): Promise<Map<string, string> | null> {
    const blobs = new Map<string, string>();
    if (ids.length === 0) return blobs;
    const result = await exec(["cat-file", "--batch"], capturedEnv, {
      capMs: options.commandCapMs,
      input: `${ids.join("\n")}\n`,
    });
    const out = result.bytes;
    if (result.status !== 0 || !out) return null;
    return parseBlobBatch(out, ids);
  }

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
    readBlobs,
    fetch: (args = []) => remoteNetwork(["fetch", ...args]),
    push: (args = [], gitOptions = []) => remoteNetwork([...gitOptions, "push", ...args]),
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

/** `remote/branch` as an upstream target; undefined when it has no `/`. */
export function parseRemoteRef(stdout: string): UpstreamTarget | undefined {
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
  if (upstream.status === 0 && configured) {
    return configured.remote.startsWith("-") || configured.branch.startsWith("-")
      ? null
      : configured;
  }

  const remoteHead = await run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const fromRemoteHead = parseRemoteRef(remoteHead.stdout);
  if (remoteHead.status === 0 && fromRemoteHead) {
    return fromRemoteHead.remote.startsWith("-") || fromRemoteHead.branch.startsWith("-")
      ? null
      : fromRemoteHead;
  }

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
