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
import { createHash } from "node:crypto";
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

export interface CompanionGitRecord {
  syncedAt?: string;
  /** Set while the last unattended run left work for a human; cleared on completion. */
  unfinishedReason?: string;
  fork?: CompanionForkRecord;
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

/** Best-effort: a failure to record never fails its caller. */
export function writeCompanionGitRecord(
  companionPath: string,
  record: CompanionGitRecord,
  homeDir?: string,
): boolean {
  const target = companionGitStatePath(companionPath, homeDir);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function recordCompanionSync(
  companionPath: string,
  at: Date = new Date(),
  homeDir?: string,
): boolean {
  const { unfinishedReason: _cleared, ...record } = readCompanionGitRecord(companionPath, homeDir);
  return writeCompanionGitRecord(companionPath, { ...record, syncedAt: at.toISOString() }, homeDir);
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
  const { syncedAt: _stale, ...record } = readCompanionGitRecord(companionPath, homeDir);
  return writeCompanionGitRecord(companionPath, { ...record, unfinishedReason: reason }, homeDir);
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
  const record = readCompanionGitRecord(companionPath, homeDir);
  return writeCompanionGitRecord(
    companionPath,
    { ...record, fork: { ...verdict, checkedAt: at.toISOString() } },
    homeDir,
  );
}
