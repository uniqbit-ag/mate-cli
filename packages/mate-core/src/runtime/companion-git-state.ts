/**
 * Bookkeeping for companion Git synchronization, kept in Mate's own state
 * directory and keyed by companion path.
 *
 * It cannot live in the Companion Repository: `.mate/` content is authoritative
 * from the upstream, and a tracked record would dirty the companion at every
 * session start — turning "only ahead" into a permanent state. It cannot live
 * in a Projection Root either: one companion serves several Working
 * Repositories, and the record is a property of the companion.
 *
 * Every write is best-effort. An unwritable record degrades to "a
 * synchronization is due", which is the safe direction.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FRAMEWORK_NAME } from "./framework";

/** Long enough that consecutive sessions do no network work. */
export const COMPANION_SYNC_TTL_MS = 4 * 60 * 60 * 1000;

/** Short enough that a repaired fork is noticed, long enough that a retry loop cannot spawn Git per write. */
export const FORK_VERDICT_TTL_MS = 60 * 1000;

export interface CompanionForkRecord {
  ahead: number;
  behind: number;
  checkedAt: string;
}

/** A change folder this checkout submitted, as it was pushed. */
export interface SubmittedFolder {
  /** SHA-256 over the folder's relative file paths and contents. */
  digest: string;
  /** The same without the Delivery Record; absent on a record of an earlier Mate. */
  content?: string;
  submittedAt: string;
}

export interface CompanionGitRecord {
  syncedAt?: string;
  /** Set while the last unattended run left work for a human; cleared on completion. */
  unfinishedReason?: string;
  fork?: CompanionForkRecord;
  /** Change folders this checkout submitted, by companion-relative path. */
  submitted?: Record<string, SubmittedFolder>;
}

/** `HOME` first, matching the guard: a projected hook runs with whatever the session set. */
export function companionGitStateRoot(homeDir?: string): string {
  const home = homeDir || process.env.HOME || os.homedir();
  return path.join(home, `.${FRAMEWORK_NAME}`, "companion-git-state");
}

function companionKey(companionPath: string): string {
  const resolved = (() => {
    try {
      return fs.realpathSync(companionPath);
    } catch {
      return path.resolve(companionPath);
    }
  })();
  return createHash("sha256").update(resolved).digest("hex").slice(0, 16);
}

export function companionGitStatePath(companionPath: string, homeDir?: string): string {
  return path.join(companionGitStateRoot(homeDir), `${companionKey(companionPath)}.json`);
}

export function readCompanionGitRecord(
  companionPath: string,
  homeDir?: string,
): CompanionGitRecord {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(companionGitStatePath(companionPath, homeDir), "utf8"),
    );
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as CompanionGitRecord;
  } catch {
    return {};
  }
}

/**
 * Best-effort: a failure to record never fails its caller. Written to a temporary file and
 * renamed, so a concurrent reader never sees a partial record.
 */
export function writeCompanionGitRecord(
  companionPath: string,
  record: CompanionGitRecord,
  homeDir?: string,
): boolean {
  const target = companionGitStatePath(companionPath, homeDir);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, target);
    return true;
  } catch {
    fs.rmSync(temporary, { force: true });
    return false;
  }
}

/** A lock older than this was left by a writer that died holding it. */
const LOCK_STALE_MS = 10_000;
/** How long a writer waits for the lock before it writes unlocked. */
const LOCK_WAIT_MS = 2_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Takes the record's lock file and returns its token, unique so it tells this lock apart
 * from one taken after it; null when it cannot within {@link LOCK_WAIT_MS}.
 */
function acquireLock(lock: string): string | null {
  const giveUpAt = Date.now() + LOCK_WAIT_MS;
  const token = `${process.pid} ${randomUUID()}`;
  for (;;) {
    try {
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fs.writeFileSync(lock, token, { flag: "wx" });
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
    }
    if (breakStaleLock(lock)) continue;
    if (Date.now() >= giveUpAt) return null;
    sleepSync(20);
  }
}

function readLockToken(lock: string): string | null {
  try {
    return fs.readFileSync(lock, "utf8");
  } catch {
    return null;
  }
}

/** A lock file left longer than {@link LOCK_STALE_MS}; never a directory or other entry. */
function isStale(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && Date.now() - stat.mtimeMs > LOCK_STALE_MS;
  } catch {
    // Gone meanwhile, or unreadable; waiting decides.
    return false;
  }
}

/**
 * Removes `lock` when a dead writer left it; true when it did. Breakers take `<lock>.break`
 * first, so only one checks and removes at a time and none can delete a lock another breaker
 * let a waiter retake. A breaker that died holding it is removed once stale.
 */
function breakStaleLock(lock: string): boolean {
  if (!isStale(lock)) return false;
  const breaker = `${lock}.break`;
  try {
    fs.writeFileSync(breaker, "", { flag: "wx" });
  } catch {
    if (isStale(breaker)) fs.rmSync(breaker, { force: true });
    return false;
  }
  try {
    if (!isStale(lock)) return false;
    fs.rmSync(lock, { force: true });
    return true;
  } finally {
    fs.rmSync(breaker, { force: true });
  }
}

/**
 * Reads the record, applies `update` and writes the result under the record's lock, so
 * concurrent sessions never drop each other's fields. Writes unlocked when the lock stays
 * taken, as best-effort bookkeeping should.
 */
function updateCompanionGitRecord(
  companionPath: string,
  update: (record: CompanionGitRecord) => CompanionGitRecord,
  homeDir?: string,
): boolean {
  const lock = `${companionGitStatePath(companionPath, homeDir)}.lock`;
  const token = acquireLock(lock);
  try {
    return writeCompanionGitRecord(
      companionPath,
      update(readCompanionGitRecord(companionPath, homeDir)),
      homeDir,
    );
  } finally {
    // Only its own: a lock held past the stale age may have been broken and retaken.
    if (token !== null && readLockToken(lock) === token) fs.rmSync(lock, { force: true });
  }
}

export function recordCompanionSync(
  companionPath: string,
  at: Date = new Date(),
  homeDir?: string,
): boolean {
  return updateCompanionGitRecord(
    companionPath,
    ({ unfinishedReason: _cleared, ...record }) => ({ ...record, syncedAt: at.toISOString() }),
    homeDir,
  );
}

/**
 * Clears `syncedAt`: a run that left work for a human is not a completion, and
 * a concurrent winner's timestamp would otherwise suppress every later run —
 * leaving this reason rendered for a whole freshness interval with nothing due
 * to clear it.
 */
export function recordCompanionSyncUnfinished(
  companionPath: string,
  reason: string,
  homeDir?: string,
): boolean {
  return updateCompanionGitRecord(
    companionPath,
    ({ syncedAt: _stale, ...record }) => ({ ...record, unfinishedReason: reason }),
    homeDir,
  );
}

function withinInterval(stamp: string | undefined, intervalMs: number, now: Date): boolean {
  if (!stamp) return false;
  const recorded = Date.parse(stamp);
  if (!Number.isFinite(recorded)) return false;
  const age = now.getTime() - recorded;
  return age >= 0 && age < intervalMs;
}

export function isCompanionSyncDue(
  companionPath: string,
  ttlMs: number = COMPANION_SYNC_TTL_MS,
  now: Date = new Date(),
  homeDir?: string,
): boolean {
  return !withinInterval(readCompanionGitRecord(companionPath, homeDir).syncedAt, ttlMs, now);
}

export function readCachedForkRecord(
  companionPath: string,
  ttlMs: number = FORK_VERDICT_TTL_MS,
  now: Date = new Date(),
  homeDir?: string,
): CompanionForkRecord | null {
  const fork = readCompanionGitRecord(companionPath, homeDir).fork;
  if (!fork || typeof fork.ahead !== "number" || typeof fork.behind !== "number") return null;
  return withinInterval(fork.checkedAt, ttlMs, now) ? fork : null;
}

export function recordForkVerdict(
  companionPath: string,
  verdict: { ahead: number; behind: number },
  at: Date = new Date(),
  homeDir?: string,
): boolean {
  return updateCompanionGitRecord(
    companionPath,
    (record) => ({ ...record, fork: { ...verdict, checkedAt: at.toISOString() } }),
    homeDir,
  );
}

/** The change folders this checkout submitted, by companion-relative path. */
export function readSubmittedFolders(
  companionPath: string,
  homeDir?: string,
): Record<string, SubmittedFolder> {
  const submitted = readCompanionGitRecord(companionPath, homeDir).submitted;
  return submitted && typeof submitted === "object" ? submitted : {};
}

/** Records `folders` as submitted from this checkout and forgets `forget`; best effort. */
export function updateSubmittedFolders(
  companionPath: string,
  folders: Record<string, SubmittedFolder>,
  forget: readonly string[] = [],
  homeDir?: string,
): boolean {
  return updateCompanionGitRecord(
    companionPath,
    (record) => {
      const submitted = { ...record.submitted, ...folders };
      for (const folder of forget) delete submitted[folder];
      return { ...record, submitted };
    },
    homeDir,
  );
}
