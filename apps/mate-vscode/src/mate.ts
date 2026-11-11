import { execFile } from "node:child_process";

import type { PendingJson } from "./pending";
import type { Runtime, Session } from "./sessions";

/** Runs `mate` through the user's login shell: GUI-started editors lack version-manager PATH entries. */

export class MateNotFoundError extends Error {
  constructor() {
    super(
      "`mate` was not found on your login shell PATH. Install Mate, then run `mate vscode setup`.",
    );
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `env` is added to the extension's environment. */
export type ShellRunner = (
  command: string,
  cwd: string,
  env?: Record<string, string>,
) => Promise<ShellResult>;

/**
 * Marks the sessions the extension starts: Mate's runtime hooks register only
 * those, and write nothing for a session started elsewhere. Only launches carry
 * it: a Claude daemon another command cold-starts would hand it to every
 * session it later runs.
 */
export const EDITOR_SESSION_ENV = { MATE_SESSION_ORIGIN: "editor" } as const;

/**
 * Lets the extension's Claude background sessions edit the checkout they start in, as
 * an interactive session does; `claude --bg` elsewhere keeps Claude's default. Mate
 * inside the session reads it back from the job's launch flags.
 */
export const IN_PLACE_SETTINGS = JSON.stringify({ worktree: { bgIsolation: "none" } });

const loginShell: ShellRunner = (command, cwd, env) =>
  new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/sh";
    execFile(
      shell,
      ["-lc", command],
      {
        cwd,
        env: { ...process.env, ...env },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120_000,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });

/** Exit 127 is the shell's "command not found". */
export async function runMateJson<T>(
  args: string[],
  cwd: string,
  run: ShellRunner = loginShell,
): Promise<T> {
  const result = await run(["mate", ...args.map(shellQuote)].join(" "), cwd);
  if (result.code === 127) throw new MateNotFoundError();
  if (result.code !== 0) {
    const message = result.stderr.trim().split("\n").findLast(Boolean);
    throw new Error(message ?? `mate ${args[0]} exited with code ${result.code}`);
  }
  // A login profile may print before the JSON document.
  const start = result.stdout.indexOf("{");
  return JSON.parse(start < 0 ? result.stdout : result.stdout.slice(start)) as T;
}

export async function listSessions(cwd: string, run?: ShellRunner): Promise<Session[]> {
  const result = await runMateJson<{ sessions: Session[] }>(
    ["session", "list", "--json"],
    cwd,
    run,
  );
  return result.sessions;
}

export async function prepareWorkspace(
  cwd: string,
  run: ShellRunner = loginShell,
): Promise<{ workspacePath: string }> {
  const help = await run("mate '--help'", cwd);
  if (help.code === 127) throw new MateNotFoundError();
  // Older CLIs silently ignore flags and would open an external editor.
  const supported = help.stdout
    .split(/\r?\n/)
    .some(
      (line) =>
        /\bcompanion open\b/.test(line) && line.includes("--no-open") && line.includes("--json"),
    );
  if (help.code !== 0 || !supported) {
    throw new Error("Update Mate, then run `mate vscode setup` to enable workspace preparation.");
  }
  return runMateJson(["companion", "open", "--no-open", "--json"], cwd, run);
}

export function addSession(
  session: { id: string; runtime: Runtime; cwd: string },
  run?: ShellRunner,
): Promise<Session> {
  return runMateJson<Session>(
    [
      "session",
      "add",
      "--runtime",
      session.runtime,
      "--id",
      session.id,
      "--cwd",
      session.cwd,
      "--origin",
      "editor",
      "--json",
    ],
    session.cwd,
    run,
  );
}

export async function removeSession(id: string, cwd: string, run?: ShellRunner): Promise<void> {
  await runMateJson(["session", "remove", id, "--json"], cwd, run);
}

/** Interrupts an OpenCode background session through its Mate OpenCode server. */
export async function stopOpenCode(id: string, cwd: string, run?: ShellRunner): Promise<void> {
  await runMateJson(["session", "stop", id, "--json"], cwd, run);
}

export function pendingArtifacts(cwd: string, run?: ShellRunner): Promise<PendingJson> {
  return runMateJson<PendingJson>(["artifact", "pending", "--json"], cwd, run);
}

/** Runs any command line through the login shell; `mate` and `claude` may live on a version manager's PATH. */
function runLogin(command: string, cwd: string, run: ShellRunner = loginShell) {
  return run(command, cwd);
}

/** One entry of `claude agents --json`, as far as the extension reads it. */
export interface ClaudeAgent {
  id?: string | null;
  sessionId: string;
  kind: string;
  state?: string | null;
  cwd?: string;
}

export async function claudeAgents(cwd: string, run?: ShellRunner): Promise<ClaudeAgent[]> {
  const result = await runLogin("claude agents --json --all", cwd, run);
  if (result.code !== 0) return [];
  const start = result.stdout.indexOf("[");
  try {
    const parsed = JSON.parse(start < 0 ? result.stdout : result.stdout.slice(start)) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is ClaudeAgent => typeof entry?.sessionId === "string")
      : [];
  } catch {
    return [];
  }
}

/** True when the installed Claude Code can run background sessions. */
export async function claudeSupportsBackground(cwd: string, run?: ShellRunner): Promise<boolean> {
  const result = await runLogin("claude --help", cwd, run);
  return result.code === 0 && /--bg\b/.test(result.stdout);
}

/** The short id `claude --bg` prints (`backgrounded · <id>`), or null. */
export function backgroundedId(output: string): string | null {
  return /backgrounded\s*·\s*([0-9a-f]{6,})/i.exec(output)?.[1] ?? null;
}

export interface BackgroundStart {
  shortId: string;
  sessionId: string;
}

/**
 * Starts a Claude session in the background through Mate (`mate claude -- --bg`,
 * with {@link IN_PLACE_SETTINGS}, and `--resume <id>` to continue one) and returns
 * its ids. Falls back to the `claude agents --json` entry that appeared in `cwd`
 * when the launch output names none.
 */
export async function startClaudeBackground(
  cwd: string,
  resumeId?: string,
  run?: ShellRunner,
): Promise<BackgroundStart> {
  const before = new Set((await claudeAgents(cwd, run)).map((agent) => agent.sessionId));
  const args = [
    "claude",
    "--",
    "--bg",
    "--settings",
    IN_PLACE_SETTINGS,
    ...(resumeId ? ["--resume", resumeId] : []),
  ];
  const result = await (run ?? loginShell)(
    ["mate", ...args.map(shellQuote)].join(" "),
    cwd,
    EDITOR_SESSION_ENV,
  );
  if (result.code === 127) throw new MateNotFoundError();
  if (result.code !== 0) {
    const message = result.stderr.trim().split("\n").findLast(Boolean);
    throw new Error(message ?? `mate claude exited with code ${result.code}`);
  }
  const agents = await claudeAgents(cwd, run);
  const printed = backgroundedId(`${result.stdout}\n${result.stderr}`);
  const agent = printed
    ? agents.find((entry) => entry.id === printed || entry.sessionId.startsWith(printed))
    : agents.find(
        (entry) => entry.kind === "background" && !before.has(entry.sessionId) && entry.cwd === cwd,
      );
  if (!agent) throw new Error("Claude did not report the background session it started.");
  return { shortId: agent.id ?? agent.sessionId.slice(0, 8), sessionId: agent.sessionId };
}

export async function stopClaude(shortId: string, cwd: string, run?: ShellRunner): Promise<void> {
  const result = await runLogin(`claude stop ${shellQuote(shortId)}`, cwd, run);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim().split("\n").findLast(Boolean) ?? "claude stop failed");
  }
}
