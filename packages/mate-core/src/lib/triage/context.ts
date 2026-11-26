import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import {
  companionFilter,
  findReports,
  readFriction,
  type FrictionEvent,
  type FrictionReport,
} from "../../runtime/friction-log";
import { formatCommand } from "../../runtime/command-arg";
import { scanContent } from "../../runtime/secret-scan";
import { FrictionRefusal } from "../friction/fields";
import type { FrictionTarget } from "../friction/mark";
import { joinFrictionStates } from "../friction/view/read";
import { TRIAGE_AGENT_NAMES, TRIAGE_AGENTS, type FoundAgent } from "./launch";

const FRICTION_SNAPSHOT_DAYS = 30;
const FRICTION_EVENTS_FILE = "friction-events.jsonl";
const FRICTION_REPORTS_FILE = "friction-reports.jsonl";
const FRICTION_STATES_FILE = "friction-states.json";

interface FrictionSnapshot {
  /** The companion the records were scoped to; none means nothing was copied. */
  companion: string | null;
  /** The current folder's companion, when the snapshot's is another. */
  mismatch?: { current: string | null };
  target?: FrictionTarget;
  /** Friction Events of a fingerprint target in other companions; they are not copied. */
  elsewhere?: { companion: string; events: number }[];
  events: number;
  reports: number;
  /** Copied fingerprints and Free Reports that have a Friction State. */
  states: number;
}

/** The target's companions, one entry per real path, with their record counts. */
function companionCounts(target: FrictionTarget): { companion: string; events: number }[] {
  const raw = new Map<string, number>();
  const companions =
    target.kind === "report"
      ? [target.report.companion]
      : target.events.map((event) => event.companion);
  for (const companion of companions) raw.set(companion, (raw.get(companion) ?? 0) + 1);
  const counts: { companion: string; events: number }[] = [];
  for (const [companion, events] of raw) {
    const same = companionFilter(companion);
    const entry = counts.find((other) => same(other.companion));
    if (entry) entry.events += events;
    else counts.push({ companion, events });
  }
  return counts;
}

/**
 * The snapshot's companion: the current folder's when it holds the target, else the target's only
 * companion. Throws a `FrictionRefusal` when several other companions hold it.
 */
export function chooseSnapshotCompanion(
  current: string | null,
  target: FrictionTarget | undefined,
): string | null {
  if (!target) return current;
  const companions = companionCounts(target).map((entry) => entry.companion);
  if (current && companions.some(companionFilter(current))) return current;
  if (companions.length === 1) return companions[0]!;
  throw new FrictionRefusal(
    "several-companions",
    `${target.id} is recorded in several companions: ${companions.join(", ")}. Run this command again in a repository of one of them; nothing was written.`,
  );
}

function targetRecords(
  target: FrictionTarget,
  companion: string,
  homeDir?: string,
): { events: FrictionEvent[]; reports: FrictionReport[] } {
  // chooseSnapshotCompanion picked a companion that holds a report target.
  if (target.kind === "report") return { events: [], reports: [target.report] };
  const inCompanion = companionFilter(companion);
  const events = target.events.filter((event) => inCompanion(event.companion));
  const ids = new Set(events.map((event) => event.id));
  const reports = findReports((report) => report.eventId !== null && ids.has(report.eventId), {
    homeDir,
  });
  return { events, reports };
}

function eventsElsewhere(
  target: FrictionTarget | undefined,
  companion: string,
): { companion: string; events: number }[] {
  if (target?.kind !== "fingerprint") return [];
  const inCompanion = companionFilter(companion);
  return companionCounts(target).filter((entry) => !inCompanion(entry.companion));
}

function mergeById<T extends { id: string; at: string }>(base: T[], extra: T[]): T[] {
  const seen = new Set(base.map((record) => record.id));
  const added = extra.filter((record) => !seen.has(record.id));
  return added.length === 0
    ? base
    : [...base, ...added].toSorted((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

const EVIDENCE_FIELDS = ["message", "command", "errorText", "paths", "flags"] as const;

async function withoutFlaggedEvidence(
  events: FrictionEvent[],
  scan: typeof scanContent,
): Promise<FrictionEvent[]> {
  const lines = events.map((event) => JSON.stringify(event));
  let flagged: Map<number, string[]> | null = new Map();
  try {
    for (const finding of await scan(FRICTION_EVENTS_FILE, lines.join("\n"))) {
      const index = finding.line - 1;
      flagged.set(index, [...(flagged.get(index) ?? []), finding.ruleId]);
    }
  } catch {
    flagged = null;
  }
  return events.map((event, index) => {
    const rules = flagged ? flagged.get(index) : ["scan-failed"];
    if (!rules) return event;
    const detail = { ...event.detail };
    for (const field of EVIDENCE_FIELDS) {
      if (field in detail) detail[field] = `[withheld: ${[...new Set(rules)].join(", ")}]`;
    }
    return { ...event, detail };
  });
}

/**
 * Copies the companion's records of the window into the session; a family without records gets
 * no file. Only that companion's: the copy feeds a public issue draft.
 */
export async function writeFrictionSnapshot(
  sessionDir: string,
  options: {
    companion: string | null;
    /** The current folder's companion; a target may choose another one. */
    current?: string | null;
    target?: FrictionTarget;
    homeDir?: string;
    now?: Date;
    scan?: typeof scanContent;
  },
): Promise<FrictionSnapshot> {
  const { companion, target, current = null, homeDir } = options;
  if (!companion) return { companion: null, events: 0, reports: 0, states: 0 };
  const elsewhere = eventsElsewhere(target, companion);
  const facts = {
    companion,
    ...(target ? { target } : {}),
    ...(elsewhere.length > 0 ? { elsewhere } : {}),
    ...(target && !(current && companionFilter(companion)(current))
      ? { mismatch: { current } }
      : {}),
  };
  const recent = readFriction(
    { companion },
    { sinceDays: FRICTION_SNAPSHOT_DAYS, homeDir, now: options.now },
  );
  const own = target ? targetRecords(target, companion, homeDir) : { events: [], reports: [] };
  const {
    events: recorded,
    reports,
    states,
  } = joinFrictionStates(
    mergeById(recent.events, own.events),
    mergeById(recent.reports, own.reports),
    homeDir,
  );
  const events = await withoutFlaggedEvidence(recorded, options.scan ?? scanContent);
  const write = (name: string, records: object[]) => {
    if (records.length === 0) return;
    const lines = records.map((record) => `${JSON.stringify(record)}\n`).join("");
    fs.writeFileSync(path.join(sessionDir, name), lines, "utf8");
  };
  write(FRICTION_EVENTS_FILE, events);
  write(FRICTION_REPORTS_FILE, reports);
  if (events.length === 0 && reports.length === 0) {
    return { ...facts, events: 0, reports: 0, states: 0 };
  }
  fs.writeFileSync(
    path.join(sessionDir, FRICTION_STATES_FILE),
    `${JSON.stringify({ v: 1, ...states }, null, 2)}\n`,
    "utf8",
  );
  return {
    ...facts,
    events: events.length,
    reports: reports.length,
    states: Object.keys(states.fingerprints).length + Object.keys(states.reports).length,
  };
}

interface TriageContextInput {
  now: Date;
  version: string;
  argv: string[];
  cwd: string;
  sessionDir: string;
  issueRepository: string | undefined;
  agents: FoundAgent[];
  friction: FrictionSnapshot;
  doctor: { report: unknown } | { error: string };
}

function runtimeVersion(): string {
  return process.versions.bun ? `Bun ${process.versions.bun}` : `Node.js ${process.versions.node}`;
}

function agentLines(agents: FoundAgent[]): string[] {
  return TRIAGE_AGENTS.map((id) => {
    const found = agents.find((agent) => agent.agent === id);
    if (!found) return `- ${TRIAGE_AGENT_NAMES[id]} (\`${id}\`): not found`;
    return `- ${TRIAGE_AGENT_NAMES[id]} (\`${id}\`): ${found.version ?? "version unknown"}, at ${found.binary}`;
  });
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function targetLines(friction: FrictionSnapshot): string[] {
  const { target, mismatch, elsewhere } = friction;
  if (!target) return [];
  const kind = target.kind === "fingerprint" ? "a fingerprint" : "a Free Report";
  const lines = [`Triage Target: \`${target.id}\`, ${kind}. Start from it.`, ""];
  if (mismatch) {
    const current = mismatch.current ? `companion ${mismatch.current}` : "no companion";
    lines.push(
      `The snapshot holds the friction of companion ${friction.companion}, which holds the Triage Target. The folder the command ran in belongs to ${current}; the doctor report describes that folder.`,
      "",
    );
  }
  if (elsewhere) {
    const list = elsewhere.map((other) => `${other.companion} (${other.events})`).join(", ");
    lines.push(
      `The Triage Target also has Friction Events in other companions, not copied here: ${list}.`,
      "",
    );
  }
  return lines;
}

function frictionLines(friction: FrictionSnapshot): string[] {
  if (!friction.companion) {
    return [
      `No friction was copied: this folder belongs to no companion. To include it, run \`${FRAMEWORK_NAME} triage\` in the affected repository.`,
    ];
  }
  const lines = targetLines(friction);
  if (friction.events === 0 && friction.reports === 0) {
    return [
      ...lines,
      `No friction was recorded for ${friction.companion} in the last ${FRICTION_SNAPSHOT_DAYS} days.`,
    ];
  }
  const older = friction.target ? ", plus the Triage Target's own records whatever their age" : "";
  lines.push(
    `Records for ${friction.companion} from the last ${FRICTION_SNAPSHOT_DAYS} days${older}, one JSON object per line:`,
  );
  if (friction.events > 0) {
    lines.push(`- \`${FRICTION_EVENTS_FILE}\`: ${count(friction.events, "Friction Event")}`);
  }
  if (friction.reports > 0) {
    lines.push(`- \`${FRICTION_REPORTS_FILE}\`: ${count(friction.reports, "agent report")}`);
  }
  lines.push(
    `- \`${FRICTION_STATES_FILE}\`: ${count(friction.states, "Friction State")}, by fingerprint and Free Report id; an item without one is open`,
  );
  return lines;
}

/** Holds no environment value: the doctor report and the facts below carry none. */
export function renderTriageContext(input: TriageContextInput): string {
  const doctor =
    "report" in input.doctor
      ? ["```json", JSON.stringify(input.doctor.report, null, 2), "```"]
      : [`The doctor report could not be built: ${input.doctor.error}`];
  return [
    `# ${FRAMEWORK_NAME} triage context`,
    "",
    `- Written: ${input.now.toISOString()}`,
    `- ${FRAMEWORK_NAME} version: ${input.version}`,
    `- Invoked as: \`${formatCommand([FRAMEWORK_NAME, "triage", ...input.argv])}\``,
    `- Executable: ${process.execPath}`,
    `- Entry point: ${process.argv[1] ?? "unknown"}`,
    `- Operating system: ${os.type()} ${os.release()} (${process.platform}, ${process.arch})`,
    `- JavaScript runtime: ${runtimeVersion()}`,
    `- Folder the command ran in: ${input.cwd}`,
    `- Triage session: ${input.sessionDir}`,
    `- Issue repository: ${input.issueRepository ?? "none set"}`,
    "",
    "## Agent Runtimes",
    "",
    ...agentLines(input.agents),
    "",
    "## Friction",
    "",
    ...frictionLines(input.friction),
    "",
    `## Doctor report for ${input.cwd}`,
    "",
    ...doctor,
    "",
  ].join("\n");
}
