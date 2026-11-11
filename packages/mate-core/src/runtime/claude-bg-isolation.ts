import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkoutAt } from "./git-layout";

type IsolationEnv = Readonly<Record<string, string | undefined>>;
type Isolation = "worktree" | "none";

export interface ClaudeSessionIsolation {
  isolated: boolean;
  /** Isolation values Claude Code does not define, each ignored. */
  diagnostics: string[];
}

function isIsolation(value: unknown): value is Isolation {
  return value === "worktree" || value === "none";
}

function ignored(source: string, value: unknown): string {
  return `${source} is ${JSON.stringify(value)}, not "worktree" or "none"; ignored`;
}

function bgIsolationOf(
  settings: unknown,
  source: string,
  diagnostics: string[],
): Isolation | undefined {
  if (typeof settings !== "object" || settings === null) return undefined;
  const worktree = (settings as { worktree?: unknown }).worktree;
  if (typeof worktree !== "object" || worktree === null) return undefined;
  const value = (worktree as { bgIsolation?: unknown }).bgIsolation;
  if (isIsolation(value)) return value;
  if (value !== undefined) diagnostics.push(ignored(`worktree.bgIsolation in ${source}`, value));
  return undefined;
}

// Lenient like Claude Code: unparseable JSON, or an unreadable file, sets nothing.
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readJson(file: string): unknown {
  try {
    return parseJson(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** A `--settings` value, a file path or inline JSON as Claude reads it. */
function flagSettings(value: string): unknown {
  return value.trimStart().startsWith("{") ? parseJson(value) : readJson(value);
}

function settingsFlagValue(flags: readonly unknown[], index: number): unknown {
  const flag = flags[index];
  if (flag === "--settings") return flags[index + 1];
  if (typeof flag === "string" && flag.startsWith("--settings=")) {
    return flag.slice("--settings=".length);
  }
  return undefined;
}

/**
 * The isolation a background job was started with: its own (e.g. `none` for a
 * backgrounded REPL), else the last `--settings` it was launched with that sets one.
 */
function jobIsolation(jobDir: string, diagnostics: string[]): Isolation | undefined {
  const state = readJson(path.join(jobDir, "state.json")) as {
    bgIsolation?: unknown;
    respawnFlags?: unknown;
  } | null;
  const own = state?.bgIsolation;
  if (isIsolation(own)) return own;
  const flags = Array.isArray(state?.respawnFlags) ? state.respawnFlags : [];
  let isolation: Isolation | undefined;
  for (let index = 0; index < flags.length; index += 1) {
    const value = settingsFlagValue(flags, index);
    if (typeof value !== "string") continue;
    isolation = bgIsolationOf(flagSettings(value), "--settings", diagnostics) ?? isolation;
  }
  return isolation;
}

/**
 * Whether Claude Code refuses this session's writes in `repoPath`: true for a background
 * session whose isolation is not `none`, when `repoPath` lies in a Git checkout that is
 * not a linked worktree. A folder outside Git, such as an Umbrella Repository, is never
 * isolated.
 *
 * @remarks
 * A background session is told by `CLAUDE_JOB_DIR`; Claude usually hides
 * `CLAUDE_CODE_SESSION_KIND` and `CLAUDE_BG_ISOLATION` from its tools, and either is
 * honored when visible. Isolation resolves from `CLAUDE_BG_ISOLATION`, then the job's
 * `state.json` (its own isolation, else the `--settings` it was launched with, as the
 * VS Code extension sets), then `worktree.bgIsolation` in
 * `<repoPath>/.claude/settings.local.json`, `<repoPath>/.claude/settings.json`, the user
 * `settings.json` (`CLAUDE_CONFIG_DIR`, else `~/.claude`), else `worktree`. An undefined
 * value is ignored and reported. Managed policy and the folder the session started in are
 * not visible here.
 */
export function claudeSessionIsolation(
  env: IsolationEnv,
  repoPath: string,
): ClaudeSessionIsolation {
  const diagnostics: string[] = [];
  const background = env.CLAUDE_CODE_SESSION_KIND === "bg" || Boolean(env.CLAUDE_JOB_DIR);
  if (!background) return { isolated: false, diagnostics };
  // Claude guards only a Git checkout, found upward as Git finds it, that is not a linked worktree.
  const checkout = checkoutAt(repoPath);
  if (!checkout || checkout.layout.kind === "linked") return { isolated: false, diagnostics };
  const isolated = resolveIsolation(env, repoPath, diagnostics) !== "none";
  return { isolated, diagnostics };
}

function resolveIsolation(env: IsolationEnv, repoPath: string, diagnostics: string[]): Isolation {
  const variable = env.CLAUDE_BG_ISOLATION;
  if (isIsolation(variable)) return variable;
  if (variable) diagnostics.push(ignored("CLAUDE_BG_ISOLATION", variable));
  const job = env.CLAUDE_JOB_DIR ? jobIsolation(env.CLAUDE_JOB_DIR, diagnostics) : undefined;
  if (job) return job;
  const userDir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude");
  const files = [
    path.join(repoPath, ".claude", "settings.local.json"),
    path.join(repoPath, ".claude", "settings.json"),
    path.join(userDir, "settings.json"),
  ];
  for (const file of files) {
    const value = bgIsolationOf(readJson(file), file, diagnostics);
    if (value) return value;
  }
  return "worktree";
}
