import { execFile } from "node:child_process";
import fs from "node:fs/promises";

import { workingRepoGit } from "./delivery/branches";
import { mergeGit } from "./delivery/merge-git";
import { processAlive } from "../runtime/opencode-server-record";
import {
  readSessionRegistry,
  sessionRegistryPath,
  sortSessions,
  updateSessionRegistry,
  type RegisteredSession,
  type SessionActivity,
  type WriteOptions,
} from "../runtime/session-registry";

/**
 * `mate session list` view of the registry: each session's state, computed
 * locally, plus pruning and label fill. Nothing here touches the network.
 */

export type SessionState = "running" | "parked" | "done";

export interface ListedSession extends RegisteredSession {
  state: SessionState;
  activity?: SessionActivity;
  /** Running Claude sessions: whether Claude's daemon runs it (`claude attach` and `claude stop` work). */
  kind?: "interactive" | "background";
  /** Running Claude background sessions: the id `claude attach` and `claude stop` take. */
  daemonId?: string;
}

/** One entry of `claude agents --json`, as far as Mate reads it. */
export interface ClaudeAgent {
  /** The daemon's short id of a background session. */
  id?: string | null;
  sessionId: string;
  kind: "interactive" | "background" | string;
  /** Background sessions: `blocked` (waiting for input), `done`, `failed`, … */
  state?: string | null;
  /** Interactive sessions: `idle` or `busy`. */
  status?: string | null;
}

export interface SessionStateDeps {
  now?: () => Date;
  /** Null when the Claude CLI cannot list its sessions. */
  claudeAgents?: () => Promise<ClaudeAgent[] | null>;
  isAlive?: (pid: number) => boolean;
  directoryExists?: (dir: string) => Promise<boolean>;
  /** True when the branch's head is merged into the default branch of the checkout at `cwd`. */
  isMerged?: (cwd: string, branch: string) => Promise<boolean>;
  readFirstPrompt?: (transcript: string) => Promise<string | null>;
}

const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const LABEL_MAX = 200;
const TRANSCRIPT_READ_BYTES = 256 * 1024;

function parseAgents(stdout: string): ClaudeAgent[] | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (entry): entry is ClaudeAgent =>
        !!entry && typeof entry === "object" && typeof entry.sessionId === "string",
    );
  } catch {
    return null;
  }
}

const readClaudeAgents = (): Promise<ClaudeAgent[] | null> =>
  new Promise((resolve) => {
    execFile(
      "claude",
      // Every directory: the sessions run in worktrees as well as this checkout.
      ["agents", "--json", "--all"],
      { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : parseAgents(stdout)),
    );
  });

async function exists(dir: string): Promise<boolean> {
  return (await fs.stat(dir).catch(() => null))?.isDirectory() ?? false;
}

/**
 * Merged when the head reached `origin/<default>` through a merge commit, or a
 * rebase or squash carried its patches there. A head already on the default
 * branch's own line (no commits of its own, or a fast-forward) is not counted,
 * so a fresh Workset branch is not hidden. A branch gone locally and from
 * `origin` counts as merged: Git keeps a checked-out branch, so its session no
 * longer works on it (the usual cleanup after a merge).
 */
export async function branchMerged(cwd: string, branch: string): Promise<boolean> {
  const repo = workingRepoGit(cwd);
  const defaultBranch = await repo.defaultBranch();
  if (branch === defaultBranch) return false;
  const git = mergeGit(cwd);
  const tip = await git.tip(branch);
  if (!tip) return git.isRepository();
  if (await git.isAncestor(tip, defaultBranch)) {
    return !(await git.onFirstParent(tip, defaultBranch));
  }
  return (await git.patchMatch(tip, defaultBranch)) !== null;
}

/** Text of a user message line in a Claude transcript; null for anything else. */
function promptText(line: string): string | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const record = entry as {
    type?: string;
    isMeta?: boolean;
    message?: { role?: string; content?: unknown };
  };
  if (record.type !== "user" || record.isMeta || record.message?.role !== "user") return null;
  const content = record.message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((part) => part && typeof part === "object" && part.type === "text")
            .map((part) => String(part.text ?? ""))
            .join(" ")
        : "";
  const trimmed = text.trim();
  // Slash commands, their output, and hook-injected blocks are not prompts.
  if (!trimmed || trimmed.startsWith("<")) return null;
  return trimmed;
}

/** First user prompt of a Claude transcript (JSONL), read from its first 256 KB. */
export async function readFirstPrompt(transcript: string): Promise<string | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(transcript, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(TRANSCRIPT_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
      const text = promptText(line);
      if (text) return text;
    }
    return null;
  } finally {
    await handle.close();
  }
}

export function shortenLabel(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > LABEL_MAX ? `${oneLine.slice(0, LABEL_MAX - 1)}…` : oneLine;
}

function claudeRunning(agent: ClaudeAgent): boolean {
  if (agent.kind === "interactive") return true;
  return agent.state !== "done" && agent.state !== "failed";
}

function claudeActivity(agent: ClaudeAgent): SessionActivity {
  if (agent.kind === "background") {
    if (agent.state === "blocked") return "waiting";
    return agent.state === "working" || agent.state === "running" ? "working" : "idle";
  }
  return agent.status === "busy" ? "working" : "idle";
}

type RunningState = Pick<ListedSession, "state" | "activity" | "kind" | "daemonId">;

function runningState(
  session: RegisteredSession,
  agents: Map<string, ClaudeAgent> | null,
  isAlive: (pid: number) => boolean,
): RunningState | null {
  if (session.runtime === "claude" && agents) {
    const agent = agents.get(session.id);
    if (!agent || !claudeRunning(agent)) return null;
    const background = agent.kind === "background";
    return {
      state: "running",
      activity: claudeActivity(agent),
      kind: background ? "background" : "interactive",
      ...(background && agent.id ? { daemonId: agent.id } : {}),
    };
  }
  if (session.endedAt || session.pid === undefined || !isAlive(session.pid)) return null;
  return session.activity ? { state: "running", activity: session.activity } : { state: "running" };
}

/** A running session stays running on a merged branch: it can still be attached and stopped. */
async function stateOf(
  session: RegisteredSession,
  agents: Map<string, ClaudeAgent> | null,
  deps: Required<Omit<SessionStateDeps, "claudeAgents" | "now" | "readFirstPrompt">>,
  merged: (cwd: string, branch: string) => Promise<boolean>,
): Promise<RunningState> {
  if (!(await deps.directoryExists(session.cwd))) return { state: "done" };
  const running = runningState(session, agents, deps.isAlive);
  if (running) return running;
  if (session.branch && (await merged(session.cwd, session.branch).catch(() => false))) {
    return { state: "done" };
  }
  return { state: "parked" };
}

/**
 * Prunes `done` sessions last seen over 30 days ago, fills missing labels from
 * Claude transcripts, and returns every remaining session with its state,
 * newest first. Writes the registry only when it pruned or labelled.
 */
export async function listSessionsWithState(
  options: WriteOptions & SessionStateDeps = {},
): Promise<{ version: 2; sessions: ListedSession[] }> {
  const deps = {
    isAlive: options.isAlive ?? processAlive,
    directoryExists: options.directoryExists ?? exists,
    isMerged: options.isMerged ?? branchMerged,
  };
  const now = (options.now ?? (() => new Date()))();
  const readPrompt = options.readFirstPrompt ?? readFirstPrompt;
  const agentList = await (options.claudeAgents ?? readClaudeAgents)();
  const agents = agentList ? new Map(agentList.map((agent) => [agent.sessionId, agent])) : null;

  const mergeCache = new Map<string, Promise<boolean>>();
  const merged = (cwd: string, branch: string) => {
    const key = `${cwd}\0${branch}`;
    if (!mergeCache.has(key)) mergeCache.set(key, deps.isMerged(cwd, branch));
    return mergeCache.get(key)!;
  };

  const file = options.file ?? sessionRegistryPath();
  // State is computed without the lock: Git checks can outlast a writer's wait.
  const registry = await readSessionRegistry(file);
  const listed: ListedSession[] = [];
  const pruned = new Set<string>();
  const labels = new Map<string, string>();
  for (const session of registry.sessions) {
    // oxlint-disable-next-line no-await-in-loop -- Git checks per session stay sequential
    const state = await stateOf(session, agents, deps, merged);
    const stale = now.getTime() - Date.parse(session.lastSeenAt) > PRUNE_AFTER_MS;
    if (state.state === "done" && stale) {
      pruned.add(session.id);
      continue;
    }
    let entry = session;
    if (!entry.label && entry.transcript) {
      // oxlint-disable-next-line no-await-in-loop -- bounded read per unlabelled session
      const prompt = await readPrompt(entry.transcript);
      if (prompt) {
        entry = { ...entry, label: shortenLabel(prompt) };
        labels.set(entry.id, entry.label!);
      }
    }
    // Stored activity is shown only through `state`, i.e. while running.
    const { activity: _stored, ...shown } = entry;
    listed.push({ ...shown, ...state });
  }

  if (pruned.size > 0 || labels.size > 0) {
    // Best-effort: a busy lock leaves the write to the next listing.
    await updateSessionRegistry(
      (current) => {
        current.sessions = current.sessions
          .filter((entry) => !pruned.has(entry.id))
          .map((entry) =>
            !entry.label && labels.has(entry.id)
              ? { ...entry, label: labels.get(entry.id)! }
              : entry,
          );
      },
      { file, lock: options.lock },
    ).catch(() => {});
  }
  return { version: 2, sessions: sortSessions(listed) as ListedSession[] };
}
