import { getActiveDistribution } from "../../distribution";
import { FRAMEWORK_NAME } from "../../framework";
import { resolveInstallContext } from "../../lib/install";
import { currentSession } from "../../lib/session-attribution";
import { triageSessionDir } from "../../lib/triage/session";
import { usageDays } from "../../lib/usage/window";
import {
  cut,
  eventSubject,
  FrictionRefusal,
  refuseSecrets,
  type SecretScan,
} from "../../lib/friction/fields";
import { markFriction } from "../../lib/friction/mark";
import type {
  FrictionFreeReport,
  FrictionGroup,
  FrictionItemState,
} from "../../lib/friction/view/model";
import { readFrictionView } from "../../lib/friction/view/read";
import { selectFriction } from "../../lib/friction/view/select";
import {
  appendReport,
  findEvent,
  frictionLogDir,
  type FrictionReport,
  type FrictionScope,
} from "../../runtime/friction-log";
import { FRICTION_RETENTION_DAYS } from "../../runtime/friction-retention";
import { readFrictionSwitch, writeFrictionSwitch } from "../../runtime/friction-switch";
import {
  MARK_STATES,
  REPORT_COSTS,
  REPORT_KINDS,
  STATE_FILTERS,
  SUBJECT_TYPES,
  type MarkState,
  type ReportCost,
  type ReportKind,
  type StateFilter,
} from "../../runtime/friction-vocabulary";
import { writeJsonStdout } from "../write-json-stdout";

const DEFAULT_DAYS = 30;

interface ListArgs {
  days: number;
  json: boolean;
  all: boolean;
  state: StateFilter;
}

function parseArgs(argv: string[]): ListArgs | string {
  let days = DEFAULT_DAYS;
  let json = false;
  let all = false;
  let state: StateFilter = "open";
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
      if (days > FRICTION_RETENTION_DAYS) {
        return `--days is at most ${FRICTION_RETENTION_DAYS}: the Friction Log keeps ${FRICTION_RETENTION_DAYS} days.`;
      }
    } else if (arg === "--state" || arg.startsWith("--state=")) {
      const value = arg === "--state" ? argv[++index] : arg.slice("--state=".length);
      if (!(STATE_FILTERS as readonly unknown[]).includes(value)) {
        return `--state must be one of ${STATE_FILTERS.join(", ")}; got "${value ?? ""}".`;
      }
      state = value as StateFilter;
    } else return `Unknown argument: ${arg}`;
  }
  return { days, json, all, state };
}

const counted = (counts: Record<string, number>) =>
  Object.entries(counts)
    .map(([name, count]) => `${name} ×${count}`)
    .join(", ");

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const minute = (at: string) => `${at.slice(0, 10)} ${at.slice(11, 16)}Z`;

/** The Friction State as one line, or nothing for an unmarked item. */
function stateLines(state: FrictionItemState | null): string[] {
  if (!state) return [];
  const words = [
    `${state.reopened ? "reopened: was " : ""}${state.state} by ${state.by} ${minute(state.at)}`,
  ];
  if (state.link) words.push(state.link);
  if (state.note) words.push(state.note);
  if (state.state === "reported" && state.eventsSince !== undefined) {
    words.push(`${plural(state.eventsSince, "event")} since reported`);
  } else if (state.reopened && state.eventsSince !== undefined) {
    words.push(`${plural(state.eventsSince, "event")} since fixed`);
  }
  return [`    ${words.join("; ")}`];
}

function renderGroup(group: FrictionGroup, all: boolean): string {
  const [latest] = group.reports;
  const named = (label: string, counts: Record<string, number>) =>
    Object.keys(counts).length > 0 ? [`    ${label}: ${counted(counts)}`] : [];
  return [
    `  ${group.fingerprint} · ${group.title}`,
    ...stateLines(group.state),
    `    ${plural(group.events, "event")} in ${plural(group.sessions, "session")}, at most ${group.maxPerSession} in one session`,
    `    first ${minute(group.firstSeen)}, last ${minute(group.lastSeen)}; mate ${counted(group.versions)}`,
    ...(all ? [`    companions: ${counted(group.companions)}`] : []),
    ...named("paths", group.paths),
    ...named("flags", group.flags),
    ...(latest
      ? [`    ${plural(group.reports.length, "report")}; latest expected: ${latest.expected}`]
      : []),
  ].join("\n");
}

function renderFreeReport(report: FrictionFreeReport, all: boolean): string {
  return [
    `  ${report.subject} (${report.kind}${report.cost ? `, ${report.cost}` : ""}) ${minute(report.at)} ${report.id}`,
    ...stateLines(report.state),
    ...(all ? [`    companion: ${report.companion}`] : []),
    `    expected: ${report.expected}`,
    `    evidence: ${report.evidence ?? ""}`,
  ].join("\n");
}

type ResolveContext = () => Promise<{ companionPath?: string }>;

export interface FrictionListDeps {
  resolveContext?: ResolveContext;
  homeDir?: string;
  now?: Date;
}

const NO_COMPANION = "no-companion";
const RECORDING_OFF_LINE = `Friction recording is off on this machine: nothing new is recorded. Turn it on with ${FRAMEWORK_NAME} friction on.`;

export async function runFrictionListCommand(
  argv: string[],
  deps: FrictionListDeps = {},
): Promise<void> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    console.error(args);
    process.exitCode = 1;
    if (argv.includes("--json")) await writeError("usage", args);
    return;
  }
  const context = await (deps.resolveContext ?? (() => resolveInstallContext()))();
  const companion = args.all ? null : context.companionPath;
  if (companion === undefined) {
    const message = `No companion resolves from this folder. Run ${FRAMEWORK_NAME} friction list inside the affected repository, or pass --all to list every companion's friction.`;
    console.error(message);
    process.exitCode = 1;
    if (args.json) await writeError(NO_COMPANION, message);
    return;
  }
  const scope: FrictionScope = companion === null ? "all" : { companion };
  const view = readFrictionView(scope, {
    days: args.days,
    homeDir: deps.homeDir,
    now: deps.now,
  });

  const shown = selectFriction(view, { state: args.state });

  if (args.json) {
    await writeJsonStdout({
      kind: "friction-list",
      version: 1,
      days: args.days,
      companion,
      state: args.state,
      recording: view.recording,
      events: view.events,
      sessions: view.sessions,
      hidden: shown.hidden,
      groups: shown.groups,
      freeReports: shown.freeReports,
    });
    return;
  }
  if (!view.recording) console.log(RECORDING_OFF_LINE);
  if (view.events === 0 && view.freeReports.length === 0) {
    console.log(`No friction recorded in the last ${args.days} days.`);
    return;
  }
  const showAll = `${FRAMEWORK_NAME} friction list --state all${args.all ? " --all" : ""}`;
  console.log(
    `Friction in the last ${args.days} days${args.all ? " in all companions" : ""}: ${plural(view.events, "event")} in ${plural(view.sessions, "session")}`,
  );
  if (shown.groups.length === 0 && shown.freeReports.length === 0) {
    console.log(
      `No ${args.state} item: ${plural(shown.hidden, "item")} hidden; ${showAll} shows them.`,
    );
    return;
  }
  if (shown.hidden > 0) {
    console.log(
      `${plural(shown.hidden, args.state === "open" ? "handled item" : "open item")} hidden; ${showAll} shows them.`,
    );
  }
  for (const group of shown.groups) console.log(renderGroup(group, args.all));
  if (shown.freeReports.length > 0) {
    console.log(`Free reports: ${shown.freeReports.length}`);
    for (const report of shown.freeReports) console.log(renderFreeReport(report, args.all));
  }
  // Triage copies only the current companion's friction and starts no agent inside an agent session.
  console.log(
    `Next: run ${FRAMEWORK_NAME} triage in your own terminal, inside the affected repository.`,
  );
}

const SUBJECT = new RegExp(`^(${SUBJECT_TYPES.join("|")})(:.+)?$`);

const REPORT_FLAGS = {
  "--kind": "kind",
  "--expected": "expected",
  "--cost": "cost",
  "--subject": "subject",
  "--evidence": "evidence",
  "--workaround": "workaround",
} as const;
const MARK_FLAGS = { "--state": "state", "--note": "note", "--link": "link" } as const;

type ValueArgs<F extends Record<string, string>> = Partial<Record<F[keyof F], string>> & {
  /** The one argument that is no flag. */
  positional?: string;
};

/** `--flag value` or `--flag=value` for each of `flags`, one positional argument, and `--json`. */
function parseValueArgs<F extends Record<string, string>>(argv: string[], flags: F): ValueArgs<F> {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") continue;
    const equals = arg.indexOf("=");
    const flag = arg.startsWith("--") && equals > 0 ? arg.slice(0, equals) : arg;
    if (Object.hasOwn(flags, flag)) {
      const value = flag === arg ? argv[++index] : arg.slice(equals + 1);
      if (value === undefined) throw new FrictionRefusal("usage", `${flag} needs a value.`);
      args[flags[flag]] = value;
    } else if (!arg.startsWith("-") && args.positional === undefined) {
      args.positional = arg;
    } else {
      throw new FrictionRefusal("usage", `Unknown argument: ${arg}`);
    }
  }
  return args as ValueArgs<F>;
}

function oneOf<T extends string>(
  values: readonly T[],
  value: string | undefined,
  flag: string,
): T | undefined {
  if (value === undefined) return undefined;
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new FrictionRefusal(
    `invalid-${flag.slice(2)}`,
    `${flag} must be one of ${values.join(", ")}; got "${value}".`,
  );
}

function present(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

const cutOrNull = (text: string | undefined) => (text === undefined ? null : cut(text));

export interface FrictionReportDeps {
  resolveContext?: ResolveContext;
  homeDir?: string;
  now?: Date;
  env?: Record<string, string | undefined>;
  scan?: SecretScan;
}

const REPORT_USAGE = `${FRAMEWORK_NAME} friction report [<event-id>] --kind <${REPORT_KINDS.join("|")}> --expected <text>`;

async function buildReport(
  args: ValueArgs<typeof REPORT_FLAGS>,
  deps: FrictionReportDeps,
): Promise<Omit<FrictionReport, "v" | "id" | "at">> {
  const kind = oneOf<ReportKind>(REPORT_KINDS, args.kind, "--kind");
  if (!kind) {
    throw new FrictionRefusal(
      "missing-kind",
      `--kind is required: one of ${REPORT_KINDS.join(", ")}. Usage: ${REPORT_USAGE}`,
    );
  }
  const expected = present(args.expected);
  if (!expected) {
    throw new FrictionRefusal("missing-expected", `--expected is required. Usage: ${REPORT_USAGE}`);
  }
  const cost = oneOf<ReportCost>(REPORT_COSTS, args.cost, "--cost") ?? null;

  if (!readFrictionSwitch(deps.homeDir)) {
    throw new FrictionRefusal(
      "recording-off",
      `Friction recording is off on this machine; nothing was recorded. A person turns it on with ${FRAMEWORK_NAME} friction on.`,
    );
  }
  const context = await (deps.resolveContext ?? (() => resolveInstallContext()))();

  let subject: string;
  const evidence = present(args.evidence);
  let companion = context.companionPath;
  if (args.positional !== undefined) {
    const event = findEvent(args.positional, { homeDir: deps.homeDir });
    if (!event) {
      throw new FrictionRefusal(
        "event-not-found",
        `No Friction Event ${args.positional} was found in the log; nothing was recorded.`,
      );
    }
    subject = eventSubject(event);
    companion ??= event.companion;
  } else {
    const named = present(args.subject);
    if (!named) {
      throw new FrictionRefusal(
        "missing-subject",
        `A free report needs --subject: one of ${SUBJECT_TYPES.join(", ")}, optionally followed by :<name>.`,
      );
    }
    if (!SUBJECT.test(named)) {
      throw new FrictionRefusal(
        "invalid-subject",
        `--subject must start with one of ${SUBJECT_TYPES.join(", ")}, optionally followed by :<name>.`,
      );
    }
    if (!evidence) {
      throw new FrictionRefusal(
        "missing-evidence",
        "A free report needs --evidence: quote what you saw, such as the message or instruction.",
      );
    }
    if (companion === undefined) {
      throw new FrictionRefusal(
        NO_COMPANION,
        `A free report needs a companion and none resolves from this folder; nothing was recorded. Run ${FRAMEWORK_NAME} friction report inside the affected repository.`,
      );
    }
    subject = named;
  }

  const report = {
    eventId: args.positional ?? null,
    kind,
    cost,
    subject: cut(subject),
    expected: cut(expected),
    evidence: cutOrNull(evidence),
    workaround: cutOrNull(present(args.workaround)),
  };
  await refuseSecrets(
    "The report",
    [report.subject, report.expected, report.evidence, report.workaround],
    deps.scan,
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

/** Records one Friction Report; refusals print to stderr, and with `--json` one document to stdout. */
export async function runFrictionReportCommand(
  argv: string[],
  deps: FrictionReportDeps = {},
): Promise<void> {
  const json = argv.includes("--json");
  try {
    const report = await buildReport(parseValueArgs(argv, REPORT_FLAGS), deps);
    let recorded: FrictionReport;
    try {
      recorded = appendReport(report, { homeDir: deps.homeDir, now: deps.now });
    } catch (error) {
      throw new FrictionRefusal(
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
    await printRefusal(error, json);
  }
}

/** Prints a refusal to stderr, and with `--json` one error document to stdout; rethrows anything else. */
async function printRefusal(error: unknown, json: boolean): Promise<void> {
  if (!(error instanceof FrictionRefusal)) throw error;
  console.error(error.message);
  process.exitCode = 1;
  if (json) await writeError(error.code, error.message);
}

async function writeError(code: string, message: string): Promise<void> {
  await writeJsonStdout({ kind: "error", version: 1, error: { code, message } });
}

export interface FrictionMarkDeps {
  homeDir?: string;
  now?: Date;
  env?: Record<string, string | undefined>;
  cwd?: string;
  scan?: SecretScan;
}

const MARK_USAGE = `${FRAMEWORK_NAME} friction mark <fingerprint|report-id> --state <${MARK_STATES.join("|")}> [--note <text>] [--link <url>] [--json]`;

/**
 * Sets a Friction State. An agent may mark only from a triage session folder, so it cannot hide
 * the friction it causes; Mate's base permission lets an agent run any mate command unprompted.
 */
export async function runFrictionMarkCommand(
  argv: string[],
  deps: FrictionMarkDeps = {},
): Promise<void> {
  const json = argv.includes("--json");
  try {
    const args = parseValueArgs(argv, MARK_FLAGS);
    const target = present(args.positional);
    const state = oneOf<MarkState>(MARK_STATES, args.state, "--state");
    if (!target || !state) {
      throw new FrictionRefusal("usage", `A target and --state are required. Usage: ${MARK_USAGE}`);
    }
    let by: "person" | "triage" = "person";
    if (currentSession(deps.env ?? process.env)) {
      if (!triageSessionDir(deps.cwd ?? process.cwd(), deps.homeDir)) {
        throw new FrictionRefusal(
          "agent-session",
          `${FRAMEWORK_NAME} friction mark records a person's decision: run it in your own terminal, or let ${FRAMEWORK_NAME} triage record it from its session folder. Nothing was changed.`,
        );
      }
      by = "triage";
    }
    const result = await markFriction(
      target,
      state,
      { note: args.note, link: args.link, by },
      deps,
    );
    if (!result.ok) throw new FrictionRefusal(result.code, result.reason);
    if (json) {
      await writeJsonStdout({ kind: "friction-state", version: 1, target, state: result.state });
    } else {
      console.log(
        result.state
          ? `Marked ${target} as ${result.state.state}.`
          : `Cleared the Friction State of ${target}: it is open.`,
      );
    }
  } catch (error) {
    await printRefusal(error, json);
  }
}

export interface FrictionSwitchDeps {
  homeDir?: string;
  env?: Record<string, string | undefined>;
}

function refuseArguments(argv: string[], allowed: string[]): boolean {
  const unknown = argv.find((arg) => !allowed.includes(arg));
  if (unknown === undefined) return false;
  console.error(`Unknown argument: ${unknown}`);
  process.exitCode = 1;
  return true;
}

/** Only a person changes the switch: Mate's base permission lets an agent run any mate command unprompted. */
export function runFrictionSwitchCommand(
  recording: boolean,
  argv: string[],
  deps: FrictionSwitchDeps = {},
): void {
  if (refuseArguments(argv, [])) return;
  const command = `${FRAMEWORK_NAME} friction ${recording ? "on" : "off"}`;
  if (currentSession(deps.env ?? process.env)) {
    console.error(
      `${command} changes a person's setting: run it in your own terminal, not in an agent session. Nothing was changed.`,
    );
    process.exitCode = 1;
    return;
  }
  writeFrictionSwitch(recording, deps.homeDir);
  const dir = frictionLogDir(deps.homeDir);
  console.log(
    recording
      ? `Friction recording is on: Mate records its refusals and failed commands in agent sessions in ${dir}.`
      : `Friction recording is off. The records made so far stay in ${dir}; delete that folder to remove them.`,
  );
}

export async function runFrictionStatusCommand(
  argv: string[],
  deps: { homeDir?: string } = {},
): Promise<void> {
  if (refuseArguments(argv, ["--json"])) return;
  const recording = readFrictionSwitch(deps.homeDir);
  const logDir = frictionLogDir(deps.homeDir);
  if (argv.includes("--json")) {
    await writeJsonStdout({ kind: "friction-status", version: 1, recording, logDir });
    return;
  }
  console.log(`Friction recording is ${recording ? "on" : "off"}. Friction Log: ${logDir}`);
}

export const FRICTION_SUBCOMMANDS = ["on", "off", "status", "list", "report", "mark"] as const;

export async function runFrictionCommand(
  subcommand: string | undefined,
  argv: string[],
): Promise<void> {
  switch (subcommand) {
    case "on":
    case "off":
      runFrictionSwitchCommand(subcommand === "on", argv);
      return;
    case "status":
      await runFrictionStatusCommand(argv);
      return;
    case "list":
      await runFrictionListCommand(argv);
      return;
    case "report":
      await runFrictionReportCommand(argv);
      return;
    case "mark":
      await runFrictionMarkCommand(argv);
      return;
    default:
      console.error(
        `${subcommand ? `Unknown friction subcommand: ${subcommand}. ` : ""}Usage: ${FRAMEWORK_NAME} friction <${FRICTION_SUBCOMMANDS.join("|")}>`,
      );
      process.exitCode = 1;
  }
}
