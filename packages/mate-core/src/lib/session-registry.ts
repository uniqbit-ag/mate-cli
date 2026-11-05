import fs from "node:fs/promises";
import path from "node:path";

import { mateHome } from "../runtime/runtime-directory";
import { writeAtomic } from "../runtime/write-atomic";

/**
 * Machine-local list of agent sessions editor plugins started through Mate,
 * so any editor can list, resume, and remove them through one CLI contract.
 */

const SESSION_RUNTIMES = ["claude", "opencode"] as const;
export type SessionRuntime = (typeof SESSION_RUNTIMES)[number];

export interface RegisteredSession {
  id: string;
  runtime: SessionRuntime;
  /** Absolute directory the session runs in. */
  cwd: string;
  /** ISO timestamp. */
  startedAt: string;
}

export interface SessionRegistryFile {
  version: 1;
  sessions: RegisteredSession[];
}

export class SessionRegistryError extends Error {}

export function sessionRegistryPath(homeDir?: string): string {
  return path.join(mateHome(homeDir), "sessions.json");
}

function isSessionRuntime(value: string): value is SessionRuntime {
  return (SESSION_RUNTIMES as readonly string[]).includes(value);
}

function isSession(value: unknown): value is RegisteredSession {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.runtime === "string" &&
    isSessionRuntime(entry.runtime) &&
    typeof entry.cwd === "string" &&
    typeof entry.startedAt === "string"
  );
}

/** Missing file reads as empty; anything unparseable is refused so it is never overwritten. */
export async function readSessionRegistry(
  file = sessionRegistryPath(),
): Promise<SessionRegistryFile> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sessions: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SessionRegistryError(`${file} is not valid JSON`);
  }
  const data = parsed as Partial<SessionRegistryFile> | null;
  if (
    !data ||
    data.version !== 1 ||
    !Array.isArray(data.sessions) ||
    !data.sessions.every(isSession)
  ) {
    throw new SessionRegistryError(`${file} is not a version 1 session registry`);
  }
  return { version: 1, sessions: data.sessions };
}

async function writeSessionRegistry(file: string, registry: SessionRegistryFile): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, `${JSON.stringify(registry, null, 2)}\n`);
}

/** Newest first. */
export async function listSessions(file = sessionRegistryPath()): Promise<SessionRegistryFile> {
  const registry = await readSessionRegistry(file);
  const sessions = registry.sessions.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));
  return { version: 1, sessions };
}

export async function addSession(
  session: { id: string; runtime: string; cwd: string },
  options: { file?: string; now?: () => Date } = {},
): Promise<RegisteredSession> {
  const file = options.file ?? sessionRegistryPath();
  if (!isSessionRuntime(session.runtime)) {
    throw new SessionRegistryError(
      `unknown runtime: ${session.runtime} (expected ${SESSION_RUNTIMES.join(" or ")})`,
    );
  }
  if (!session.id) throw new SessionRegistryError("session id must not be empty");
  const requested = path.resolve(session.cwd);
  const stat = await fs.stat(requested).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new SessionRegistryError(`directory does not exist: ${requested}`);
  }
  // Real path, so callers comparing against Git worktree paths match through symlinks.
  const cwd = await fs.realpath(requested);

  const registry = await readSessionRegistry(file);
  if (registry.sessions.some((entry) => entry.id === session.id)) {
    throw new SessionRegistryError(`session already registered: ${session.id}`);
  }
  const added: RegisteredSession = {
    id: session.id,
    runtime: session.runtime,
    cwd,
    startedAt: (options.now?.() ?? new Date()).toISOString(),
  };
  await writeSessionRegistry(file, { version: 1, sessions: [...registry.sessions, added] });
  return added;
}

/** Deletes the record only; the conversation and any process are untouched. */
export async function removeSession(
  id: string,
  file = sessionRegistryPath(),
): Promise<RegisteredSession> {
  const registry = await readSessionRegistry(file);
  const removed = registry.sessions.find((entry) => entry.id === id);
  if (!removed) throw new SessionRegistryError(`session not registered: ${id}`);
  await writeSessionRegistry(file, {
    version: 1,
    sessions: registry.sessions.filter((entry) => entry !== removed),
  });
  return removed;
}
