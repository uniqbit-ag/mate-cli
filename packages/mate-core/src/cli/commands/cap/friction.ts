import { getActiveDistribution } from "../../../distribution";
import { FRAMEWORK_NAME } from "../../../framework";
import { resolveInstallContext } from "../../../lib/install";
import type { FrameworkConfig } from "../../../lib/orchestrator/types";
import { currentSession } from "../../../lib/session-attribution";
import { usageDays } from "../../../lib/usage/window";
import {
  appendReport,
  companionFilter,
  findEvent,
  readEvents,
  readReports,
  REPORT_COSTS,
  REPORT_KINDS,
  type FrictionEvent,
  type FrictionReport,
  type ReportCost,
  type ReportKind,
} from "../../../runtime/friction-log";
import { FRICTION_CAPABILITY } from "../../../runtime/friction-recorder";
import { scanContent, type SecretFinding } from "../../../runtime/secret-scan";
import { ensureCapabilityEnabled } from "../../plugin-commands";
import { writeJsonStdout } from "../../write-json-stdout";

interface FrictionGroup {
  fingerprint: string;
  events: number;
  sessions: number;
  /** The highest event count within one session. */
  maxPerSession: number;
  firstSeen: string;
  lastSeen: string;
  /** Mate version → event count. */
  versions: Record<string, number>;
  /** Companion path → event count. */
  companions: Record<string, number>;
  /** Reports on the group's events, newest first. */
  reports: FrictionReport[];
}

interface FrictionSummary {
  events: number;
  sessions: number;
  groups: FrictionGroup[];
  /** Reports on no event, newest first. */
  freeReports: FrictionReport[];
}

const newestFirst = (reports: FrictionReport[]) =>
  reports.toSorted((a, b) => b.at.localeCompare(a.at));

/** Grouped by fingerprint; repeats within one session rank first, then the event count. */
function summarizeFriction(events: FrictionEvent[], reports: FrictionReport[]): FrictionSummary {
  const reportsByEvent = Map.groupBy(
    reports.filter((report) => report.eventId),
    (report) => report.eventId,
  );
  const byFingerprint = new Map<string, FrictionEvent[]>();
  for (const event of events) {
    const grouped = byFingerprint.get(event.fingerprint);
    if (grouped) grouped.push(event);
    else byFingerprint.set(event.fingerprint, [event]);
  }
  const groups = [...byFingerprint].map(([fingerprint, grouped]): FrictionGroup => {
    const perSession = new Map<string, number>();
    const versions: Record<string, number> = {};
    const companions: Record<string, number> = {};
    for (const event of grouped) {
      perSession.set(event.sessionId, (perSession.get(event.sessionId) ?? 0) + 1);
      versions[event.mateVersion] = (versions[event.mateVersion] ?? 0) + 1;
      companions[event.companion] = (companions[event.companion] ?? 0) + 1;
    }
    const times = grouped.map((event) => event.at).toSorted();
    return {
      fingerprint,
      events: grouped.length,
      sessions: perSession.size,
      maxPerSession: Math.max(...perSession.values()),
      firstSeen: times[0],
      lastSeen: times[times.length - 1],
      versions,
      companions,
      reports: newestFirst(grouped.flatMap((event) => reportsByEvent.get(event.id) ?? [])),
    };
  });
  groups.sort((a, b) => b.maxPerSession - a.maxPerSession || b.events - a.events);
  return {
    events: events.length,
    sessions: new Set(events.map((event) => event.sessionId)).size,
    groups,
    freeReports: newestFirst(reports.filter((report) => !report.eventId)),
  };
}

const DEFAULT_DAYS = 30;

function parseArgs(argv: string[]): { days: number; json: boolean; all: boolean } | string {
  let days = DEFAULT_DAYS;
  let json = false;
  let all = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if (arg === "--all") all = true;
    else if (arg === "--days" || arg.startsWith("--days=")) {
      try {
        days = usageDays(arg === "--days" ? argv[++index] : arg.slice("--days=".length));
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    } else return `Unknown argument: ${arg}`;
  }
  return { days, json, all };
}

const counted = (counts: Record<string, number>) =>
  Object.entries(counts)
    .map(([name, count]) => `${name} ×${count}`)
    .join(", ");

function renderGroup(group: FrictionGroup, all: boolean): string {
  const [latest] = group.reports;
  return [
    `  ${group.fingerprint}`,
    `    ${group.events} events in ${group.sessions} sessions, at most ${group.maxPerSession} in one session`,
    `    first ${group.firstSeen}, last ${group.lastSeen}; mate ${counted(group.versions)}`,
    ...(all ? [`    companions: ${counted(group.companions)}`] : []),
    ...(latest ? [`    ${group.reports.length} reports; latest expected: ${latest.expected}`] : []),
  ].join("\n");
}

function renderFreeReport(report: FrictionReport, all: boolean): string {
  return [
    `  ${report.subject} (${report.kind}${report.cost ? `, ${report.cost}` : ""}) ${report.at}`,
    ...(all ? [`    companion: ${report.companion}`] : []),
    `    expected: ${report.expected}`,
    `    evidence: ${report.evidence ?? ""}`,
  ].join("\n");
}

export interface FrictionListDeps {
  resolveContext?: () => Promise<{ companionPath?: string; config: FrameworkConfig }>;
  homeDir?: string;
  now?: Date;
}

export async function runFrictionListCommand(
  argv: string[],
  deps: FrictionListDeps = {},
): Promise<void> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    console.error(args);
    process.exitCode = 1;
    return;
  }
  const context = await (deps.resolveContext ?? (() => resolveInstallContext()))();
  if (
    !(await ensureCapabilityEnabled(FRICTION_CAPABILITY, {
      loadConfig: async () => context.config,
    }))
  )
    return;
  const companion = args.all ? "" : (context.companionPath ?? "");
  const window = { sinceDays: args.days, homeDir: deps.homeDir, now: deps.now };
  const inCompanion = companionFilter(companion);
  // A report on an event joins by id, wherever it was made; free reports are this companion's.
  const summary = summarizeFriction(
    readEvents({ ...window, companion }),
    readReports(window).filter((report) => report.eventId || inCompanion(report.companion)),
  );

  if (args.json) {
    await writeJsonStdout({
      kind: "friction-list",
      version: 1,
      days: args.days,
      companion: args.all ? null : companion,
      events: summary.events,
      sessions: summary.sessions,
      groups: summary.groups,
      freeReports: summary.freeReports,
    });
    return;
  }
  if (summary.events === 0 && summary.freeReports.length === 0) {
    console.log(`No friction recorded in the last ${args.days} days.`);
    return;
  }
  console.log(
    `Friction in the last ${args.days} days${args.all ? " in all companions" : ""}: ${summary.events} events in ${summary.sessions} sessions`,
  );
  for (const group of summary.groups) console.log(renderGroup(group, args.all));
  if (summary.freeReports.length > 0) {
    console.log(`Free reports: ${summary.freeReports.length}`);
    for (const report of summary.freeReports) console.log(renderFreeReport(report, args.all));
  }
}

const SUBJECT_TYPES = ["command", "hook", "skill", "guidance", "capability", "docs"] as const;
const SUBJECT = new RegExp(`^(${SUBJECT_TYPES.join("|")})(:.+)?$`);
const TEXT_LIMIT = 1_000;
/** The scanner needs a file name; the report is scanned as a companion write would be. */
const SCAN_NAME = "friction-report.md";

const VALUE_FLAGS = {
  "--kind": "kind",
  "--expected": "expected",
  "--cost": "cost",
  "--subject": "subject",
  "--evidence": "evidence",
  "--workaround": "workaround",
} as const;
type ValueField = (typeof VALUE_FLAGS)[keyof typeof VALUE_FLAGS];

interface ReportArgs extends Partial<Record<ValueField, string>> {
  eventId?: string;
}

class ReportRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function isValueFlag(flag: string): flag is keyof typeof VALUE_FLAGS {
  return Object.hasOwn(VALUE_FLAGS, flag);
}

function parseReportArgs(argv: string[]): ReportArgs {
  const args: ReportArgs = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") continue;
    const equals = arg.indexOf("=");
    const flag = arg.startsWith("--") && equals > 0 ? arg.slice(0, equals) : arg;
    if (isValueFlag(flag)) {
      const value = flag === arg ? argv[++index] : arg.slice(equals + 1);
      if (value === undefined) throw new ReportRefusal("usage", `${flag} needs a value.`);
      args[VALUE_FLAGS[flag]] = value;
    } else if (!arg.startsWith("-") && args.eventId === undefined) {
      args.eventId = arg;
    } else {
      throw new ReportRefusal("usage", `Unknown argument: ${arg}`);
    }
  }
  return args;
}

function oneOf<T extends string>(
  values: readonly T[],
  value: string | undefined,
  flag: string,
): T | undefined {
  if (value === undefined) return undefined;
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new ReportRefusal(
    `invalid-${flag.slice(2)}`,
    `${flag} must be one of ${values.join(", ")}; got "${value}".`,
  );
}

function present(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

/** `hook:<check>` for a refusal, `command:<command words>` for a failed command. */
function eventSubject(event: FrictionEvent): string {
  const [kind, name] = event.fingerprint.split(":");
  return kind === "refusal" ? `hook:${name}` : `command:${name}`;
}

const cut = (text: string) => text.slice(0, TEXT_LIMIT);
const cutOrNull = (text: string | undefined) => (text === undefined ? null : cut(text));

export interface FrictionReportDeps {
  resolveContext?: () => Promise<{ companionPath?: string; config: FrameworkConfig }>;
  homeDir?: string;
  now?: Date;
  env?: Record<string, string | undefined>;
  scan?: (filePath: string, content: string) => Promise<SecretFinding[]>;
}

const REPORT_USAGE = `${FRAMEWORK_NAME} cap friction report [<event-id>] --kind <${REPORT_KINDS.join("|")}> --expected <text>`;

async function buildReport(
  args: ReportArgs,
  deps: FrictionReportDeps,
): Promise<Omit<FrictionReport, "v" | "id" | "at"> | null> {
  const kind = oneOf<ReportKind>(REPORT_KINDS, args.kind, "--kind");
  if (!kind) {
    throw new ReportRefusal(
      "missing-kind",
      `--kind is required: one of ${REPORT_KINDS.join(", ")}. Usage: ${REPORT_USAGE}`,
    );
  }
  const expected = present(args.expected);
  if (!expected) {
    throw new ReportRefusal("missing-expected", `--expected is required. Usage: ${REPORT_USAGE}`);
  }
  const cost = oneOf<ReportCost>(REPORT_COSTS, args.cost, "--cost") ?? null;

  const context = await (deps.resolveContext ?? (() => resolveInstallContext()))();
  if (
    !(await ensureCapabilityEnabled(FRICTION_CAPABILITY, {
      loadConfig: async () => context.config,
    }))
  ) {
    return null;
  }

  let subject: string;
  const evidence = present(args.evidence);
  let companion = context.companionPath ?? "";
  if (args.eventId !== undefined) {
    const event = findEvent(args.eventId, { homeDir: deps.homeDir });
    if (!event) {
      throw new ReportRefusal(
        "event-not-found",
        `No Friction Event ${args.eventId} was found in the log; nothing was recorded.`,
      );
    }
    subject = eventSubject(event);
    companion ||= event.companion;
  } else {
    const named = present(args.subject);
    if (!named) {
      throw new ReportRefusal(
        "missing-subject",
        `A free report needs --subject: one of ${SUBJECT_TYPES.join(", ")}, optionally followed by :<name>.`,
      );
    }
    if (!SUBJECT.test(named)) {
      throw new ReportRefusal(
        "invalid-subject",
        `--subject must start with one of ${SUBJECT_TYPES.join(", ")}, optionally followed by :<name>.`,
      );
    }
    if (!evidence) {
      throw new ReportRefusal(
        "missing-evidence",
        "A free report needs --evidence: quote what you saw, such as the message or instruction.",
      );
    }
    subject = named;
  }

  const report = {
    eventId: args.eventId ?? null,
    kind,
    cost,
    subject: cut(subject),
    expected: cut(expected),
    evidence: cutOrNull(evidence),
    workaround: cutOrNull(present(args.workaround)),
  };
  await refuseSecrets(
    [report.subject, report.expected, report.evidence, report.workaround],
    deps.scan ?? scanContent,
  );

  const session = currentSession(deps.env ?? process.env);
  return {
    ...report,
    mateVersion: getActiveDistribution().config.version,
    companion,
    sessionId: session?.id ?? null,
    runtime: session?.runtime ?? null,
  };
}

/** The refusal names the scanner's rules, never the text. */
async function refuseSecrets(
  fields: (string | null)[],
  scan: NonNullable<FrictionReportDeps["scan"]>,
): Promise<void> {
  let findings: SecretFinding[];
  try {
    findings = await scan(SCAN_NAME, fields.filter((field) => field !== null).join("\n"));
  } catch {
    throw new ReportRefusal(
      "scan-failed",
      "The report could not be scanned for secrets; nothing was recorded.",
    );
  }
  if (findings.length > 0) {
    const rules = [...new Set(findings.map((finding) => finding.ruleId))];
    throw new ReportRefusal(
      "secret",
      `The report holds a secret (${rules.join(", ")}); nothing was recorded. Replace the value with a placeholder or the variable name.`,
    );
  }
}

/** Records one Friction Report; refusals print to stderr, and with `--json` one document to stdout. */
export async function runFrictionReportCommand(
  argv: string[],
  deps: FrictionReportDeps = {},
): Promise<void> {
  const json = argv.includes("--json");
  try {
    const report = await buildReport(parseReportArgs(argv), deps);
    if (!report) {
      if (json) await writeError("capability-disabled", "The friction capability is not enabled.");
      return;
    }
    let recorded: FrictionReport;
    try {
      recorded = appendReport(report, { homeDir: deps.homeDir, now: deps.now });
    } catch (error) {
      throw new ReportRefusal(
        "write-failed",
        `The report could not be written: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (json) {
      await writeJsonStdout({
        kind: "friction-report",
        version: 1,
        id: recorded.id,
        eventId: recorded.eventId,
      });
    } else {
      console.log(`Recorded friction report ${recorded.id}.`);
    }
  } catch (error) {
    if (!(error instanceof ReportRefusal)) throw error;
    console.error(error.message);
    process.exitCode = 1;
    if (json) await writeError(error.code, error.message);
  }
}

async function writeError(code: string, message: string): Promise<void> {
  await writeJsonStdout({ kind: "error", version: 1, error: { code, message } });
}
