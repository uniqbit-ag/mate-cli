import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { realPath } from "./git-layout";
import { mateHome } from "./runtime-directory";
import type { SessionRuntime } from "./session-registry";

/**
 * Machine-local, append-only record of the refusals and failed commands Mate
 * caused in agent sessions. One JSON line per event, one file per UTC month;
 * a single append per event, so concurrent hooks need no lock.
 */

type FrictionKind = "refusal" | "command-failure";
export type FrictionRuntime = SessionRuntime;

export interface FrictionEvent {
  v: 1;
  id: string;
  /** ISO 8601 UTC. */
  at: string;
  kind: FrictionKind;
  fingerprint: string;
  mateVersion: string;
  runtime: FrictionRuntime;
  sessionId: string;
  companion: string;
  repositoryPath: string | null;
  detail: Record<string, unknown>;
}

export type NewFrictionEvent = Omit<FrictionEvent, "v" | "id" | "at">;

/** Months kept before the current one. */
const RETAINED_PREVIOUS_MONTHS = 2;
const LOG_FILE = /^events-(\d{4}-\d{2})\.jsonl$/;

export function frictionLogDir(homeDir?: string): string {
  return path.join(mateHome(homeDir), "friction");
}

function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function monthsBefore(month: string, count: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return monthOf(new Date(Date.UTC(year, monthNumber - 1 - count, 1)));
}

export function frictionLogFile(month: string, homeDir?: string): string {
  return path.join(frictionLogDir(homeDir), `events-${month}.jsonl`);
}

function logMonths(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .map((name) => LOG_FILE.exec(name)?.[1])
    .filter((month): month is string => Boolean(month));
}

function pruneBefore(dir: string, oldestKept: string): void {
  for (const month of logMonths(dir)) {
    if (month < oldestKept) fs.rmSync(path.join(dir, `events-${month}.jsonl`), { force: true });
  }
}

interface AppendOptions {
  homeDir?: string;
  now?: Date;
}

/** Best effort: every failure is swallowed. */
export function appendEvent(event: NewFrictionEvent, options: AppendOptions = {}): void {
  try {
    const now = options.now ?? new Date();
    const month = monthOf(now);
    const dir = frictionLogDir(options.homeDir);
    const file = frictionLogFile(month, options.homeDir);
    const record: FrictionEvent = {
      v: 1,
      id: crypto.randomUUID(),
      at: now.toISOString(),
      ...event,
    };
    fs.mkdirSync(dir, { recursive: true });
    const created = !fs.existsSync(file);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
    if (created) pruneBefore(dir, monthsBefore(month, RETAINED_PREVIOUS_MONTHS));
  } catch {
    // recording never changes the outcome it records
  }
}

function isFrictionEvent(value: unknown): value is FrictionEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    event.v === 1 &&
    typeof event.at === "string" &&
    typeof event.fingerprint === "string" &&
    typeof event.sessionId === "string" &&
    typeof event.companion === "string"
  );
}

function parseLine(line: string): FrictionEvent | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isFrictionEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface ReadEventsOptions {
  sinceDays: number;
  /** Only events recorded for this companion. */
  companion?: string;
  homeDir?: string;
  now?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The guard records the companion as it resolved it, which may be a link to the one asked for. */
function samePath(target: string): (candidate: string) => boolean {
  const wanted = realPath(target);
  const seen = new Map<string, boolean>();
  return (candidate) => {
    let same = seen.get(candidate);
    if (same === undefined) {
      same = realPath(candidate) === wanted;
      seen.set(candidate, same);
    }
    return same;
  };
}

/** Events in the window, oldest file first; unreadable files and unparseable lines are skipped. */
export function readEvents(options: ReadEventsOptions): FrictionEvent[] {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - options.sinceDays * DAY_MS);
  const dir = frictionLogDir(options.homeDir);
  const companion = options.companion ? samePath(options.companion) : undefined;
  let months: string[];
  try {
    months = logMonths(dir).filter((month) => month >= monthOf(since));
  } catch {
    return [];
  }
  const events: FrictionEvent[] = [];
  for (const month of months.toSorted()) {
    let text: string;
    try {
      text = fs.readFileSync(frictionLogFile(month, options.homeDir), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const event = parseLine(line);
      if (!event) continue;
      const at = Date.parse(event.at);
      if (Number.isNaN(at) || at < since.getTime()) continue;
      if (companion && !companion(event.companion)) continue;
      events.push(event);
    }
  }
  return events;
}
