import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { FRICTION_RETENTION_DAYS } from "./friction-retention";
import type { ReportCost, ReportKind } from "./friction-vocabulary";
import { realPath } from "./git-layout";
import { mateHome } from "./runtime-directory";
import type { SessionRuntime } from "./session-registry";

/**
 * Machine-local, append-only record of the refusals and failed commands Mate
 * caused in agent sessions, and of the agents' reports on them. One JSON line
 * per record, one file per family and UTC month; a single append per record,
 * so concurrent hooks need no lock.
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

/** An agent's judgement on a Friction Event, or a free report on friction that has none. */
export interface FrictionReport {
  v: 1;
  id: string;
  /** ISO 8601 UTC. */
  at: string;
  eventId: string | null;
  kind: ReportKind;
  cost: ReportCost | null;
  subject: string;
  expected: string;
  evidence: string | null;
  workaround: string | null;
  mateVersion: string;
  companion: string;
  sessionId: string | null;
  runtime: FrictionRuntime | null;
}

export type NewFrictionReport = Omit<FrictionReport, "v" | "id" | "at">;

type Family = "events" | "reports";

const DAY_MS = 24 * 60 * 60 * 1000;

function familyPattern(family: Family): RegExp {
  return new RegExp(`^${family}-(\\d{4}-\\d{2})\\.jsonl$`);
}

export function frictionLogDir(homeDir?: string): string {
  return path.join(mateHome(homeDir), "friction");
}

function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function familyFile(family: Family, month: string, homeDir?: string): string {
  return path.join(frictionLogDir(homeDir), `${family}-${month}.jsonl`);
}

export function frictionLogFile(month: string, homeDir?: string): string {
  return familyFile("events", month, homeDir);
}

export function frictionReportFile(month: string, homeDir?: string): string {
  return familyFile("reports", month, homeDir);
}

function logMonths(dir: string, family: Family): string[] {
  const pattern = familyPattern(family);
  return fs
    .readdirSync(dir)
    .map((name) => pattern.exec(name)?.[1])
    .filter((month): month is string => Boolean(month));
}

function pruneBefore(family: Family, oldestKept: string, homeDir?: string): void {
  for (const month of logMonths(frictionLogDir(homeDir), family)) {
    if (month < oldestKept) fs.rmSync(familyFile(family, month, homeDir), { force: true });
  }
}

interface AppendOptions {
  homeDir?: string;
  now?: Date;
}

/** Throws on a failed write; the first record of a month prunes its family's old files. */
function appendRecord<T extends object>(
  family: Family,
  fields: T,
  options: AppendOptions,
): T & { v: 1; id: string; at: string } {
  const now = options.now ?? new Date();
  const month = monthOf(now);
  const dir = frictionLogDir(options.homeDir);
  const file = familyFile(family, month, options.homeDir);
  const record = { v: 1 as const, id: crypto.randomUUID(), at: now.toISOString(), ...fields };
  fs.mkdirSync(dir, { recursive: true });
  const created = !fs.existsSync(file);
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  if (created) {
    const oldestKept = monthOf(new Date(now.getTime() - FRICTION_RETENTION_DAYS * DAY_MS));
    pruneBefore(family, oldestKept, options.homeDir);
  }
  return record;
}

/** Best effort: every failure is swallowed and returns null. */
export function appendEvent(
  event: NewFrictionEvent,
  options: AppendOptions = {},
): FrictionEvent | null {
  try {
    return appendRecord("events", event, options);
  } catch {
    // recording never changes the outcome it records
    return null;
  }
}

/** Unlike an event, a report is asked for, so a failed write throws. */
export function appendReport(
  report: NewFrictionReport,
  options: AppendOptions = {},
): FrictionReport {
  return appendRecord("reports", report, options);
}

/** A version-1 record whose `fields` are strings. */
function recordOf<T>(fields: string[]): (value: unknown) => value is T {
  return (value): value is T => {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return record.v === 1 && fields.every((field) => typeof record[field] === "string");
  };
}

const hasEventStrings = recordOf<FrictionEvent>([
  "id",
  "at",
  "fingerprint",
  "sessionId",
  "companion",
]);

/** Readers index into `detail`, so a line without one counts as unparseable. */
function isFrictionEvent(value: unknown): value is FrictionEvent {
  return hasEventStrings(value) && typeof value.detail === "object" && value.detail !== null;
}

const isFrictionReport = recordOf<FrictionReport>([
  "id",
  "at",
  "kind",
  "subject",
  "expected",
  "companion",
]);

function parseLine<T>(line: string, accept: (value: unknown) => value is T): T | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return accept(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface ReadOptions {
  sinceDays: number;
  homeDir?: string;
  now?: Date;
}

/** One companion's records, or every companion's. */
export type FrictionScope = { companion: string } | "all";

/**
 * Whether a recorded companion is this one. The guard records the companion as it
 * resolved it, which may be a link to the one asked for.
 */
function companionFilter(target: string): (candidate: string) => boolean {
  // An empty path would resolve to the current folder.
  if (!target) return () => false;
  const wanted = realPath(target);
  const seen = new Map<string, boolean>();
  return (candidate) => {
    if (!candidate) return false;
    let same = seen.get(candidate);
    if (same === undefined) {
      same = realPath(candidate) === wanted;
      seen.set(candidate, same);
    }
    return same;
  };
}

/** A month's records in file order; an unreadable file or an unparseable line is skipped. */
function readMonth<T>(
  family: Family,
  month: string,
  accept: (value: unknown) => value is T,
  homeDir?: string,
): T[] {
  let text: string;
  try {
    text = fs.readFileSync(familyFile(family, month, homeDir), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => parseLine(line, accept))
    .filter((record): record is T => record !== null);
}

function readFamily<T extends { at: string }>(
  family: Family,
  accept: (value: unknown) => value is T,
  options: ReadOptions,
): T[] {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - options.sinceDays * DAY_MS);
  const dir = frictionLogDir(options.homeDir);
  let months: string[];
  try {
    months = logMonths(dir, family).filter((month) => month >= monthOf(since));
  } catch {
    return [];
  }
  return months
    .toSorted()
    .flatMap((month) => readMonth(family, month, accept, options.homeDir))
    .filter((record) => {
      const at = Date.parse(record.at);
      return !Number.isNaN(at) && at >= since.getTime();
    });
}

/** Every companion's events in the window, oldest file first. */
export function readEvents(options: ReadOptions): FrictionEvent[] {
  return readFamily("events", isFrictionEvent, options);
}

/** Every companion's reports in the window, oldest file first. */
export function readReports(options: ReadOptions): FrictionReport[] {
  return readFamily("reports", isFrictionReport, options);
}

/**
 * A scope's events in the window, the reports on those events wherever they were made,
 * and the scope's free reports.
 */
export function readFriction(
  scope: FrictionScope,
  options: ReadOptions,
): { events: FrictionEvent[]; reports: FrictionReport[] } {
  const inScope = scope === "all" ? () => true : companionFilter(scope.companion);
  const events = readEvents(options).filter((event) => inScope(event.companion));
  const ids = new Set(events.map((event) => event.id));
  const reports = readReports(options).filter((report) =>
    report.eventId ? ids.has(report.eventId) : inScope(report.companion),
  );
  return { events, reports };
}

/** The first record, newest month first, that `match` accepts; null when none or no log. */
function findRecord<T>(
  family: Family,
  accept: (value: unknown) => value is T,
  match: (record: T) => boolean,
  homeDir?: string,
): T | null {
  let months: string[];
  try {
    months = logMonths(frictionLogDir(homeDir), family);
  } catch {
    return null;
  }
  for (const month of months.toSorted().toReversed()) {
    const found = readMonth(family, month, accept, homeDir).find(match);
    if (found) return found;
  }
  return null;
}

/** The event with this id in any retained month, or null. */
export function findEvent(id: string, options: { homeDir?: string } = {}): FrictionEvent | null {
  return findRecord("events", isFrictionEvent, (event) => event.id === id, options.homeDir);
}

/** The newest event with this fingerprint in any retained month, or null. */
export function findFingerprint(
  fingerprint: string,
  options: { homeDir?: string } = {},
): FrictionEvent | null {
  return findRecord(
    "events",
    isFrictionEvent,
    (event) => event.fingerprint === fingerprint,
    options.homeDir,
  );
}

/** The report with this id in any retained month, or null. */
export function findReport(id: string, options: { homeDir?: string } = {}): FrictionReport | null {
  return findRecord("reports", isFrictionReport, (report) => report.id === id, options.homeDir);
}

/** The ids of every report in the retained months. */
export function readReportIds(options: { homeDir?: string } = {}): Set<string> {
  let months: string[];
  try {
    months = logMonths(frictionLogDir(options.homeDir), "reports");
  } catch {
    return new Set();
  }
  return new Set(
    months.flatMap((month) =>
      readMonth("reports", month, isFrictionReport, options.homeDir).map((report) => report.id),
    ),
  );
}

/** Whether no earlier line of the event's month holds the same session and fingerprint. */
export function firstInSession(event: FrictionEvent, options: { homeDir?: string } = {}): boolean {
  const month = readMonth("events", monthOf(new Date(event.at)), isFrictionEvent, options.homeDir);
  for (const recorded of month) {
    if (recorded.id === event.id) return true;
    if (recorded.sessionId === event.sessionId && recorded.fingerprint === event.fingerprint) {
      return false;
    }
  }
  return true;
}
