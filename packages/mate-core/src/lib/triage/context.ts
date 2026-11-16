import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { readEvents, readReports } from "../../runtime/friction-log";
import { TRIAGE_AGENT_NAMES, TRIAGE_AGENTS, type FoundAgent } from "./launch";

const FRICTION_SNAPSHOT_DAYS = 30;
const FRICTION_EVENTS_FILE = "friction-events.jsonl";
const FRICTION_REPORTS_FILE = "friction-reports.jsonl";

interface FrictionSnapshot {
  events: number;
  reports: number;
}

/** Copies the window's records into the session; a family without records gets no file. */
export function writeFrictionSnapshot(
  sessionDir: string,
  options: { homeDir?: string; now?: Date },
): FrictionSnapshot {
  const window = { sinceDays: FRICTION_SNAPSHOT_DAYS, homeDir: options.homeDir, now: options.now };
  const events = readEvents(window);
  const reports = readReports(window);
  const write = (name: string, records: object[]) => {
    if (records.length === 0) return;
    const lines = records.map((record) => `${JSON.stringify(record)}\n`).join("");
    fs.writeFileSync(path.join(sessionDir, name), lines, "utf8");
  };
  write(FRICTION_EVENTS_FILE, events);
  write(FRICTION_REPORTS_FILE, reports);
  return { events: events.length, reports: reports.length };
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

const SECRET_NAME = /TOKEN|SECRET|PASSW|KEY|CREDENTIAL|AUTH/i;

/**
 * Plugin configs interpolate `${VAR}`, so a plugin's error text in the doctor report may echo a
 * secret, raw or JSON-escaped. Short values stay: masking them would garble the facts.
 */
export function maskSecretValues(text: string, env: Record<string, string | undefined>): string {
  let masked = text;
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !SECRET_NAME.test(name)) continue;
    for (const form of new Set([JSON.stringify(value).slice(1, -1), value])) {
      masked = masked.split(form).join("***");
    }
  }
  return masked;
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
  if (friction.events === 0 && friction.reports === 0) {
    return [`No friction was recorded in the last ${FRICTION_SNAPSHOT_DAYS} days.`];
  }
  const lines = [`Records from the last ${FRICTION_SNAPSHOT_DAYS} days, one JSON object per line:`];
  if (friction.events > 0) {
    lines.push(`- \`${FRICTION_EVENTS_FILE}\`: ${count(friction.events, "Friction Event")}`);
  }
  if (friction.reports > 0) {
    lines.push(`- \`${FRICTION_REPORTS_FILE}\`: ${count(friction.reports, "agent report")}`);
  }
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
