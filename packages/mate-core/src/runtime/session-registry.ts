import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { mateHome } from "./runtime-directory";
import { writeAtomic } from "./write-atomic";

/**
 * Machine-local list of the agent sessions an editor plugin started, so it can
 * list, resume, and remove them through one CLI contract. Mate's runtime hooks
 * keep those entries current; they add a session only when its launch carries
 * `MATE_SESSION_ORIGIN=editor`, and write nothing for any other session.
 */

/** Set by an editor plugin on the launches it starts; the runtime hooks register only those. */
export const SESSION_ORIGIN_ENV = "MATE_SESSION_ORIGIN";

export function startedByEditor(env: Record<string, string | undefined>): boolean {
  return env[SESSION_ORIGIN_ENV] === "editor";
}

const SESSION_RUNTIMES = ["claude", "opencode"] as const;
export type SessionRuntime = (typeof SESSION_RUNTIMES)[number];

const SESSION_ORIGINS = ["editor", "managed", "unmanaged"] as const;
/** Who started the session: an editor plugin, a Mate launch, or the runtime on its own. */
export type SessionOrigin = (typeof SESSION_ORIGINS)[number];

const SESSION_ACTIVITIES = ["working", "idle", "waiting"] as const;
export type SessionActivity = (typeof SESSION_ACTIVITIES)[number];

export interface RegisteredSession {
  id: string;
  runtime: SessionRuntime;
  origin: SessionOrigin;
  /** Absolute directory the session runs in. */
  cwd: string;
  /** ISO timestamps. */
  startedAt: string;
  lastSeenAt: string;
  endedAt?: string;
  pid?: number;
  branch?: string;
  /** Absolute path of the runtime's transcript, for the label. */
  transcript?: string;
  /** First user prompt, or the runtime's own title. */
  label?: string;
  /** Change the session works on, recorded by commands run inside it. */
  change?: string;
  /** When the runtime last asked the user for input. */
  attentionAt?: string;
  /** Stored by runtimes that report it themselves (OpenCode); meaningful while running. */
  activity?: SessionActivity;
}

export interface SessionRegistryFile {
  version: 2;
  sessions: RegisteredSession[];
}

export class SessionRegistryError extends Error {}

export function sessionRegistryPath(homeDir?: string): string {
  return path.join(mateHome(homeDir), "sessions.json");
}

function isSessionRuntime(value: string): value is SessionRuntime {
  return (SESSION_RUNTIMES as readonly string[]).includes(value);
}

function isSessionOrigin(value: string): value is SessionOrigin {
  return (SESSION_ORIGINS as readonly string[]).includes(value);
}

const OPTIONAL_STRINGS = [
  "endedAt",
  "branch",
  "transcript",
  "label",
  "change",
  "attentionAt",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isV1Session(entry: Record<string, unknown>): boolean {
  return (
    typeof entry.id === "string" &&
    typeof entry.runtime === "string" &&
    isSessionRuntime(entry.runtime) &&
    typeof entry.cwd === "string" &&
    typeof entry.startedAt === "string"
  );
}

function isV2Session(entry: Record<string, unknown>): boolean {
  return (
    isV1Session(entry) &&
    typeof entry.origin === "string" &&
    isSessionOrigin(entry.origin) &&
    typeof entry.lastSeenAt === "string" &&
    (entry.pid === undefined || typeof entry.pid === "number") &&
    OPTIONAL_STRINGS.every((key) => entry[key] === undefined || typeof entry[key] === "string") &&
    (entry.activity === undefined ||
      (SESSION_ACTIVITIES as readonly unknown[]).includes(entry.activity))
  );
}

/** Version 1 entries were all started from an editor plugin. */
function fromV1(entry: Record<string, unknown>): RegisteredSession {
  const startedAt = entry.startedAt as string;
  return {
    id: entry.id as string,
    runtime: entry.runtime as SessionRuntime,
    origin: "editor",
    cwd: entry.cwd as string,
    startedAt,
    lastSeenAt: startedAt,
  };
}

/** Missing file reads as empty; anything unparseable is refused so it is never overwritten. */
export async function readSessionRegistry(
  file = sessionRegistryPath(),
): Promise<SessionRegistryFile> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, sessions: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SessionRegistryError(`${file} is not valid JSON`);
  }
  const invalid = new SessionRegistryError(`${file} is not a version 1 or 2 session registry`);
  if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) throw invalid;
  const entries = parsed.sessions as unknown[];
  if (!entries.every(isRecord)) throw invalid;
  if (parsed.version === 1 && entries.every(isV1Session)) {
    return { version: 2, sessions: entries.map(fromV1) };
  }
  if (parsed.version === 2 && entries.every(isV2Session)) {
    return { version: 2, sessions: entries as unknown as RegisteredSession[] };
  }
  throw invalid;
}

async function writeSessionRegistry(file: string, registry: SessionRegistryFile): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, `${JSON.stringify(registry, null, 2)}\n`);
}

const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;

export interface LockOptions {
  waitMs?: number;
  staleMs?: number;
  now?: () => number;
}

const readOwner = (file: string) => fs.readFile(file, "utf8").catch(() => null);

/**
 * Takes over a stale lock by moving it aside first: of several writers that
 * found it stale, only one move succeeds. A lock that turns out to be another
 * writer's fresh one is put back.
 */
async function takeOverStale(lock: string, owner: string, token: string): Promise<void> {
  const aside = `${lock}.${token}`;
  try {
    await fs.rename(lock, aside);
  } catch {
    return;
  }
  if ((await readOwner(aside)) !== owner) await fs.link(aside, lock).catch(() => {});
  await fs.rm(aside, { force: true });
}

/**
 * Exclusive `<file>.lock` around a read-modify-write. Waits up to 2 s and takes
 * over a lock untouched for 10 s (a crashed writer); the holder touches it while
 * it works, so a slow writer is never taken over. Throws when it cannot get it.
 */
export async function withLock<T>(file: string, fn: () => Promise<T>, options: LockOptions = {}) {
  const lock = `${file}.lock`;
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const deadline = now() + (options.waitMs ?? LOCK_WAIT_MS);
  const token = `${process.pid}.${crypto.randomUUID()}`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  // oxlint-disable no-await-in-loop -- retry loop
  for (;;) {
    try {
      const handle = await fs.open(lock, "wx");
      try {
        await handle.writeFile(token);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readOwner(lock);
      const stat = await fs.stat(lock).catch(() => null);
      if (owner !== null && stat && now() - stat.mtimeMs > staleMs) {
        await takeOverStale(lock, owner, token);
        continue;
      }
      if (now() >= deadline) {
        throw new SessionRegistryError(`${file} is locked by another writer (${lock})`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  // oxlint-enable no-await-in-loop
  const touch = setInterval(() => {
    const at = new Date();
    void fs.utimes(lock, at, at).catch(() => {});
  }, staleMs / 3);
  touch.unref();
  try {
    return await fn();
  } finally {
    clearInterval(touch);
    if ((await readOwner(lock)) === token) await fs.rm(lock, { force: true });
  }
}

export interface WriteOptions {
  file?: string;
  now?: () => Date;
  lock?: LockOptions;
}

/** Read, change, and write the registry under the lock; `change` returns the value to hand back. */
export async function updateSessionRegistry<T>(
  change: (registry: SessionRegistryFile) => T | Promise<T>,
  options: WriteOptions = {},
): Promise<T> {
  const file = options.file ?? sessionRegistryPath();
  return withLock(
    file,
    async () => {
      const registry = await readSessionRegistry(file);
      const before = JSON.stringify(registry);
      const result = await change(registry);
      if (JSON.stringify(registry) !== before) await writeSessionRegistry(file, registry);
      return result;
    },
    options.lock,
  );
}

/** Lock-free first look, so a write for a session nobody registered costs one read. */
export async function isRegistered(id: string, options: WriteOptions): Promise<boolean> {
  const registry = await readSessionRegistry(options.file ?? sessionRegistryPath());
  return registry.sessions.some((entry) => entry.id === id);
}

/** Lock-free: true when the session is registered and marked ended. */
export async function isEnded(id: string, options: WriteOptions): Promise<boolean> {
  const registry = await readSessionRegistry(options.file ?? sessionRegistryPath());
  return !!registry.sessions.find((entry) => entry.id === id)?.endedAt;
}

/** Newest `lastSeenAt` first. */
export function sortSessions(sessions: RegisteredSession[]): RegisteredSession[] {
  return sessions.toSorted((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

/** The raw registry, newest first; state and pruning live in `session-state`. */
export async function listSessions(file = sessionRegistryPath()): Promise<SessionRegistryFile> {
  const registry = await readSessionRegistry(file);
  return { version: 2, sessions: sortSessions(registry.sessions) };
}

export interface SessionInput {
  id: string;
  runtime: string;
  cwd: string;
  origin?: string;
  pid?: number;
  branch?: string;
  transcript?: string;
  label?: string;
}

const PRUNE_ON_ADD_MS = 30 * 24 * 60 * 60 * 1000;

/** Ended, or its directory gone, and not seen for 30 days. */
async function outdated(session: RegisteredSession, now: Date): Promise<boolean> {
  if (now.getTime() - Date.parse(session.lastSeenAt) <= PRUNE_ON_ADD_MS) return false;
  if (session.endedAt) return true;
  return !(await fs.stat(session.cwd).catch(() => null))?.isDirectory();
}

/**
 * Registers a session, or refreshes a registered one: new `cwd`, `lastSeenAt`,
 * and the runtime facts given; `endedAt` cleared; `startedAt`, `origin`,
 * `label`, `change`, and `attentionAt` kept. A new entry drops the sessions
 * that ended, or whose directory is gone, over 30 days ago.
 */
export function addSession(
  input: SessionInput,
  options: WriteOptions = {},
): Promise<RegisteredSession> {
  return upsertSession(input, options, true) as Promise<RegisteredSession>;
}

/** Refreshes a registered session as `addSession` does; null, and no write, when it is not registered. */
export async function refreshSession(
  input: SessionInput,
  options: WriteOptions = {},
): Promise<RegisteredSession | null> {
  if (!(await isRegistered(input.id, options))) return null;
  return upsertSession(input, options, false);
}

async function upsertSession(
  input: SessionInput,
  options: WriteOptions,
  create: boolean,
): Promise<RegisteredSession | null> {
  if (!isSessionRuntime(input.runtime)) {
    throw new SessionRegistryError(
      `unknown runtime: ${input.runtime} (expected ${SESSION_RUNTIMES.join(" or ")})`,
    );
  }
  const origin = input.origin ?? "editor";
  if (!isSessionOrigin(origin)) {
    throw new SessionRegistryError(
      `unknown origin: ${origin} (expected ${SESSION_ORIGINS.join(", ")})`,
    );
  }
  if (!input.id) throw new SessionRegistryError("session id must not be empty");
  const requested = path.resolve(input.cwd);
  const stat = await fs.stat(requested).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new SessionRegistryError(`directory does not exist: ${requested}`);
  }
  // Real path, so callers comparing against Git worktree paths match through symlinks.
  const cwd = await fs.realpath(requested);
  const runtime = input.runtime;
  const now = options.now?.() ?? new Date();
  const seenAt = now.toISOString();

  return updateSessionRegistry(async (registry) => {
    const existing = registry.sessions.find((entry) => entry.id === input.id);
    const facts = {
      ...(input.pid !== undefined ? { pid: input.pid } : {}),
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
      ...(input.transcript !== undefined ? { transcript: input.transcript } : {}),
    };
    if (existing) {
      const { endedAt: _ended, ...rest } = existing;
      const refreshed: RegisteredSession = {
        ...rest,
        ...facts,
        ...(existing.label === undefined && input.label ? { label: input.label } : {}),
        cwd,
        lastSeenAt: seenAt,
      };
      registry.sessions[registry.sessions.indexOf(existing)] = refreshed;
      return refreshed;
    }
    if (!create) return null;
    const stale = await Promise.all(registry.sessions.map((entry) => outdated(entry, now)));
    registry.sessions = registry.sessions.filter((_, index) => !stale[index]);
    const added: RegisteredSession = {
      id: input.id,
      runtime,
      origin,
      cwd,
      startedAt: seenAt,
      lastSeenAt: seenAt,
      ...facts,
      ...(input.label ? { label: input.label } : {}),
    };
    registry.sessions.push(added);
    return added;
  }, options);
}

/**
 * Applies `patch` to a registered session; null when the id is not registered.
 * `undefined` values in the patch are ignored.
 */
export async function patchSession(
  id: string,
  patch: Partial<Omit<RegisteredSession, "id" | "runtime" | "origin" | "startedAt">>,
  options: WriteOptions = {},
): Promise<RegisteredSession | null> {
  if (!(await isRegistered(id, options))) return null;
  return updateSessionRegistry((registry) => {
    const index = registry.sessions.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    const patched = { ...registry.sessions[index]!, ...defined };
    registry.sessions[index] = patched;
    return patched;
  }, options);
}

/** Marks the session ended now; null when the id is not registered. */
export function endSession(id: string, options: WriteOptions = {}) {
  const at = (options.now?.() ?? new Date()).toISOString();
  return patchSession(id, { endedAt: at, lastSeenAt: at }, options);
}

/** Deletes the record only; the conversation and any process are untouched. */
export async function removeSession(
  id: string,
  file = sessionRegistryPath(),
): Promise<RegisteredSession> {
  return updateSessionRegistry(
    (registry) => {
      const removed = registry.sessions.find((entry) => entry.id === id);
      if (!removed) throw new SessionRegistryError(`session not registered: ${id}`);
      registry.sessions = registry.sessions.filter((entry) => entry !== removed);
      return removed;
    },
    { file },
  );
}
