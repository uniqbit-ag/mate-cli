import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { mateHome } from "./runtime-directory";

/**
 * Per-companion lock under `<mate home>/locks/`, outside the companion's tree;
 * repos share a companion, so a per-repo lock would race pulls. Re-entrant per
 * async call chain, not per process.
 */

export interface CompanionLockOptions {
  homeDir?: string;
  /** `false` tries once and returns `acquired: false` at once when the lock is held. */
  wait?: boolean;
  /** How long to wait for another holder before giving up. */
  timeoutMs?: number;
  pollMs?: number;
  /** Called once, when the lock is found held and the caller starts waiting. */
  onWait?: () => void;
}

export type CompanionLockResult<T> = { acquired: true; value: T } | { acquired: false };

function companionKey(companionPath: string): string {
  let resolved = path.resolve(companionPath);
  try {
    resolved = fsSync.realpathSync(resolved);
  } catch {
    /* an unresolvable companion is still keyed by its spelling */
  }
  return crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 32);
}

export function companionLockPath(companionPath: string, homeDir?: string): string {
  return path.join(mateHome(homeDir), "locks", `${companionKey(companionPath)}.lock`);
}

const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();

/** An unreadable holder id is only trusted this long, so a corrupt lock cannot block forever. */
const UNREADABLE_LOCK_GRACE_MS = 10_000;

async function holderAlive(lockPath: string, raw: string): Promise<boolean> {
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    const stat = await fs.stat(lockPath).catch(() => null);
    return stat !== null && Date.now() - stat.mtimeMs < UNREADABLE_LOCK_GRACE_MS;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The holder's pid is written to a private file first and hard-linked into
 * place, so the lock never exists without its holder: a contender reading an
 * empty file in between would otherwise take it as stale and remove it.
 */
async function tryAcquire(lockPath: string): Promise<boolean> {
  const tempPath = `${lockPath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, String(process.pid));
  try {
    await fs.link(tempPath, lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await fs.rm(tempPath, { force: true });
  }
  const raw = await fs.readFile(lockPath, "utf8").catch(() => null);
  if (raw === null || (await holderAlive(lockPath, raw))) return false;
  /** A dead holder's lock is removed only if it is still the one just read. */
  if ((await fs.readFile(lockPath, "utf8").catch(() => null)) === raw) {
    await fs.rm(lockPath, { force: true });
  }
  return false;
}

/**
 * Runs `task` while holding the companion's lock; `acquired: false` after the
 * bounded wait, or at once with `wait: false`. A caller already holding it in
 * this call chain runs `task` directly.
 */
export async function withCompanionLock<T>(
  companionPath: string,
  options: CompanionLockOptions,
  task: () => Promise<T>,
): Promise<CompanionLockResult<T>> {
  const lockPath = companionLockPath(companionPath, options.homeDir);
  const held = heldLocks.getStore() ?? new Set<string>();
  if (held.has(lockPath)) return { acquired: true, value: await task() };

  const timeoutMs = options.wait === false ? 0 : (options.timeoutMs ?? 30_000);
  const pollMs = options.pollMs ?? 200;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  let waiting = false;
  // oxlint-disable-next-line no-await-in-loop -- polling is the point
  while (!(await tryAcquire(lockPath))) {
    if (Date.now() >= deadline) return { acquired: false };
    if (!waiting) {
      waiting = true;
      options.onWait?.();
    }
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  try {
    return { acquired: true, value: await heldLocks.run(new Set([...held, lockPath]), task) };
  } finally {
    await fs.rm(lockPath, { force: true });
  }
}
