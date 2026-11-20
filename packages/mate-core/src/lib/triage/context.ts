import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { readFriction, type FrictionEvent } from "../../runtime/friction-log";
import { readFrictionStates } from "../../runtime/friction-state";
import { scanContent } from "../../runtime/secret-scan";
import { summarizeFriction } from "../friction/summary";
import { TRIAGE_AGENT_NAMES, TRIAGE_AGENTS, type FoundAgent } from "./launch";

const FRICTION_SNAPSHOT_DAYS = 30;
const FRICTION_EVENTS_FILE = "friction-events.jsonl";
const FRICTION_REPORTS_FILE = "friction-reports.jsonl";
const FRICTION_STATES_FILE = "friction-states.json";

interface FrictionSnapshot {
  /** The companion the records were scoped to; none means nothing was copied. */
  companion: string | null;
  events: number;
  reports: number;
  /** Copied fingerprints and Free Reports that have a Friction State. */
  states: number;
}

const EVIDENCE_FIELDS = ["message", "command", "errorText", "paths", "flags"] as const;

/** Evidence text the scanner flags, or every event's when it cannot scan, is withheld. */
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
    homeDir?: string;
    now?: Date;
    scan?: typeof scanContent;
  },
): Promise<FrictionSnapshot> {
  const { companion } = options;
  if (!companion) return { companion: null, events: 0, reports: 0, states: 0 };
  const { events: recorded, reports } = readFriction(
    { companion },
    { sinceDays: FRICTION_SNAPSHOT_DAYS, homeDir: options.homeDir, now: options.now },
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
    return { companion, events: 0, reports: 0, states: 0 };
  }
  const summary = summarizeFriction(recorded, reports, readFrictionStates(options.homeDir));
  const states = {
    v: 1,
    fingerprints: Object.fromEntries(
      summary.groups
        .filter((group) => group.state)
        .map((group) => [group.fingerprint, group.state]),
    ),
    reports: Object.fromEntries(
      summary.freeReports
        .filter((report) => report.state)
        .map((report) => [report.id, report.state]),
    ),
  };
  fs.writeFileSync(
    path.join(sessionDir, FRICTION_STATES_FILE),
    `${JSON.stringify(states, null, 2)}\n`,
    "utf8",
  );
  return {
    companion,
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

function frictionLines(friction: FrictionSnapshot): string[] {
  if (!friction.companion) {
    return [
      `No friction was copied: this folder belongs to no companion. To include it, run \`${FRAMEWORK_NAME} triage\` in the affected repository.`,
    ];
  }
  if (friction.events === 0 && friction.reports === 0) {
    return [
      `No friction was recorded for ${friction.companion} in the last ${FRICTION_SNAPSHOT_DAYS} days.`,
    ];
  }
  const lines = [
    `Records for ${friction.companion} from the last ${FRICTION_SNAPSHOT_DAYS} days, one JSON object per line:`,
  ];
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
    `- Invoked as: \`${[FRAMEWORK_NAME, "triage", ...input.argv].join(" ")}\``,
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
